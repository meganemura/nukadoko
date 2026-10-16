import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the Markdown run summary as `nuka run` actually writes it:
// to the run's own directory, to `--summary <path>`, and appended to
// `$GITHUB_STEP_SUMMARY`; once for a whole `--concurrency` run; and with a
// real declared/observed disagreement measured against a local HTTP server.
// The exact layout of each section is pinned in run-summary-render.test.ts;
// here the input is a real run, so only the values a run cannot fix in
// advance (run id, times, versions, record ids) are normalized.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function runIdOf(stdoutText: string): string {
  return (JSON.parse(nonEmptyLines(stdoutText)[0]!) as { run_id: string }).run_id;
}

async function readRunSummary(rootDir: string, runId: string): Promise<string> {
  return readFile(path.join(rootDir, ".nukadoko", "records", "runs", runId, "summary.md"), "utf8");
}

function normalize(markdown: string, runId: string): string {
  return markdown
    .replaceAll(runId, "<run>")
    .replace(`- nukadoko: ${readOwnVersion()}`, "- nukadoko: <version>")
    .replace(/started \S+, finished \S+ \([^)]*\)/, "started <t>, finished <t> (<duration>)")
    .replace(/\| \d+\.\ds \|/g, "| <d>s |")
    .replace(/records\/steps\/[a-z0-9-]+/g, "records/steps/<id>");
}

describe("nuka run: the run summary", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempDir(rootDir);
  });

  it("writes a green run's summary to the run directory", async () => {
    await initGitRepo(rootDir);
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/passing.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    const runId = runIdOf(stdout.text());
    const summary = normalize(await readRunSummary(rootDir, runId), runId).replace(/`[0-9a-f]{7}`/, "`<sha>`");
    expect(summary).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run passed: 1 scenario, 1 passed",
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## features/passing.feature",
        "",
        "| scenario | line | status | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| create and check a thing | 3 | passed | <d>s |  |",
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
        "",
      ].join("\n"),
    );
  });

  it("writes a red run's failing step, its error, its record, and the rerun command", async () => {
    await initGitRepo(rootDir);
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/failing.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);

    const runId = runIdOf(stdout.text());
    const summary = normalize(await readRunSummary(rootDir, runId), runId).replace(/`[0-9a-f]{7}`/, "`<sha>`");
    expect(summary).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run failed: 1 scenario, 0 passed, 1 failed",
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## features/failing.feature",
        "",
        "| scenario | line | status | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        '| an operation fails partway through | 3 | failed | <d>s | step "the operation fails": `operation failed on purpose`<br>record `.nukadoko/records/steps/<id>` |',
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
        "",
        "## Rerun a failed scenario",
        "",
        "```sh",
        "nuka run features/failing.feature:3",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("appends to $GITHUB_STEP_SUMMARY rather than replacing what earlier steps wrote", async () => {
    const stepSummary = path.join(rootDir, "step-summary.md");
    await writeFile(stepSummary, "earlier step\n");
    vi.stubEnv("GITHUB_STEP_SUMMARY", stepSummary);

    const first = createCaptureSink();
    await runCli(["run", "--no-check", "features/passing.feature"], { rootDir, stdout: first, stderr: createCaptureSink() });
    const second = createCaptureSink();
    await runCli(["run", "--no-check", "features/failing.feature"], { rootDir, stdout: second, stderr: createCaptureSink() });

    const firstSummary = await readRunSummary(rootDir, runIdOf(first.text()));
    const secondSummary = await readRunSummary(rootDir, runIdOf(second.text()));
    expect(await readFile(stepSummary, "utf8")).toBe(`earlier step\n${firstSummary}${secondSummary}`);
  });

  it("writes the same summary to --summary <path>, replacing an older file there", async () => {
    await writeFile(path.join(rootDir, "old.md"), "stale\n");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["run", "--no-check", "features/passing.feature", "--summary", "out/pr-comment.md"], { rootDir, stdout, stderr });

    const runId = runIdOf(stdout.text());
    const runCopy = await readRunSummary(rootDir, runId);
    expect(await readFile(path.join(rootDir, "out", "pr-comment.md"), "utf8")).toBe(runCopy);
    expect(nonEmptyLines(stderr.text())).toContain(`summary   ${path.join(".nukadoko", "records", "runs", runId, "summary.md")}`);
  });

  it("names a summary it could not write on stderr and keeps the run's exit code", async () => {
    await writeFile(path.join(rootDir, "blocker"), "a file, not a directory\n");
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/passing.feature", "--summary", "blocker/summary.md"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toMatch(/^Warning: the run summary was not written to blocker\/summary\.md: /m);
  });
});

describe("nuka run --concurrency: the run summary", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes one summary for the whole run, with one row per scenario record", async () => {
    const stdout = createCaptureSink();
    await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], { rootDir, stdout, stderr: createCaptureSink() });

    const records = nonEmptyLines(stdout.text()).map(
      (line) => JSON.parse(line) as { run_id: string; feature: string; line: number; scenario: string },
    );
    expect(records.length).toBeGreaterThan(1);
    const summary = await readRunSummary(rootDir, records[0]!.run_id);
    const rows = summary.split("\n").filter((line) => /^\| .* \| (passed|failed) \|/.test(line));
    expect(rows).toHaveLength(records.length);
    for (const record of records) {
      expect(summary).toContain(`## ${record.feature}`);
      expect(rows.filter((row) => row.startsWith(`| ${record.scenario} | ${record.line} |`))).toHaveLength(1);
    }
  });
});

describe("nuka run: the summary's declared vs observed section", () => {
  let server: Server;
  let rootDir: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    rootDir = await copyFixtureToTempDir("observed-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      `import { defineConfig } from "./nukadoko-shim.js";\nexport default defineConfig({ baseURL: "http://127.0.0.1:${port}" });\n`,
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("lists a step that declared mutates: false and was measured posting", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/read-only-policy.feature:7"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const summary = await readRunSummary(rootDir, runIdOf(stdout.text()));
    expect(summary.slice(summary.indexOf("## Declared vs observed"))).toBe(
      [
        "## Declared vs observed",
        "",
        "Steps that declared `mutates: false` and were measured making writes. This is a comparison, not a verdict: a step that reads over POST records writes by design.",
        "",
        '- "a step lying about being read-only runs" (scenario "a step that declares mutates false but actually writes is trusted anyway"): declared mutates: false, observed 1 write',
        "",
      ].join("\n"),
    );
  });
});
