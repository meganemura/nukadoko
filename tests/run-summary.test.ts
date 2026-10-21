import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the Markdown run summary as `nuka run` actually writes it:
// to the run's own directory, and appended to
// `$GITHUB_STEP_SUMMARY`; once for a whole `--concurrency` run; and with a
// real declared/observed disagreement measured against a local HTTP server.
// The exact layout of each section is pinned in run-summary-render.test.ts;
// here the input is a real run, so only the values a run cannot fix in
// advance (run id, times, versions, record ids) are normalized.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function newestRunId(rootDir: string): string {
  return latestRunJson(rootDir).run_id as string;
}

async function readRunSummary(rootDir: string, runId: string): Promise<string> {
  return readFile(path.join(rootDir, ".nukadoko", "runs", runId, "summary.md"), "utf8");
}

function normalize(markdown: string, runId: string): string {
  return markdown
    .replaceAll(runId, "<run>")
    .replace(`- nukadoko: ${readOwnVersion()}`, "- nukadoko: <version>")
    .replace(/started \S+, finished \S+ \([^)]*\)/, "started <t>, finished <t> (<duration>)")
    .replace(/\| \d+\.\ds \|/g, "| <d>s |")
    .replace(/steps\/step-[a-z0-9-]+/g, "steps/<id>");
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

    const runId = newestRunId(rootDir);
    const summary = normalize(await readRunSummary(rootDir, runId), runId).replace(/`[0-9a-f]{7}`/, "`<sha>`");
    expect(summary).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run passed: 1 scenario, 1 passed",
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- selection: full",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## features/passing.feature",
        "",
        "| scenario | line | default | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| create and check a thing | 3 | passed | <d>s |  |",
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write or changing a file.",
        "",
        "1 step that declared `mutates: false` reached no HTTP channel nukadoko observes (`request`, `page`, `context`, `pageAs`) and ran no process through `runCommand` whose files were measured, so nothing was compared for it.",
        "",
      ].join("\n"),
    );
  });

  it("writes a red run's failing step, its error, its record, and the rerun command", async () => {
    await initGitRepo(rootDir);
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/failing.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);

    const runId = newestRunId(rootDir);
    const summary = normalize(await readRunSummary(rootDir, runId), runId).replace(/`[0-9a-f]{7}`/, "`<sha>`");
    expect(summary).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run failed: 1 scenario, 0 passed, 1 failed",
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- selection: full",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## features/failing.feature",
        "",
        "| scenario | line | default | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        '| an operation fails partway through | 3 | failed | <d>s | step "the operation fails": `operation failed on purpose`<br>record `steps/<id>` |',
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write or changing a file.",
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

    await runCli(["run", "--no-check", "features/passing.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    const firstSummary = await readRunSummary(rootDir, newestRunId(rootDir));
    await runCli(["run", "--no-check", "features/failing.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    const secondSummary = await readRunSummary(rootDir, newestRunId(rootDir));
    expect(await readFile(stepSummary, "utf8")).toBe(`earlier step\n${firstSummary}${secondSummary}`);
  });

  it("names a summary it could not write on stderr and keeps the run's exit code", async () => {
    await writeFile(path.join(rootDir, "blocker"), "a file, not a directory\n");
    vi.stubEnv("GITHUB_STEP_SUMMARY", path.join(rootDir, "blocker", "summary.md"));
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toMatch(/^warning\tsummary-not-written\t-\t[Tt]he run summary was not written to GITHUB_STEP_SUMMARY: ENOTDIR/m);
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

  it("writes one summary for the whole run, with one row per scenario", async () => {
    await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    const document = latestRunJson(rootDir);
    const records = document.scenarios as { feature: string; line: number; scenario: string }[];
    expect(records.length).toBeGreaterThan(1);
    const summary = await readRunSummary(rootDir, document.run_id as string);
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

    const summary = await readRunSummary(rootDir, newestRunId(rootDir));
    expect(summary.slice(summary.indexOf("## Declared vs observed"))).toBe(
      [
        "## Declared vs observed",
        "",
        "Steps that declared `mutates: false` and were measured making writes or changing files. This is a comparison, not a verdict: a step that reads over POST records writes by design, and a file change is a change under a process's working directory, whoever made it.",
        "",
        '- "a step lying about being read-only runs" (scenario "a step that declares mutates false but actually writes is trusted anyway"): declared mutates: false, observed 1 write',
        "",
      ].join("\n"),
    );
  });
});
