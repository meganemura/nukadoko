import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the Markdown run summary as `nuka run` actually writes it:
// to the run's own directory, and appended to
// `$GITHUB_STEP_SUMMARY`, and once for a whole `--concurrency` run.
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
        "# nukadoko run passed: 1 criterion, 1 held",
        "",
        "| verdict | criterion | head default |",
        "| --- | --- | --- |",
        "| held | `features/passing.feature:3` create and check a thing | pass |",
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- selection: full",
        "- check: skipped (`nuka run --no-check`), so no finding of `nuka check` held this run back",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## Scenarios with no claim",
        "",
        "In each scenario below, no claim on a Then line was judged (held, broken, or unjudged).",
        "",
        "- `features/passing.feature:3` create and check a thing: no claim on a Then line was judged in it",
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
        "# nukadoko run failed: 1 criterion, 0 held, 1 failed",
        "",
        "| verdict | criterion | head default |",
        "| --- | --- | --- |",
        "| failed | `features/failing.feature:3` an operation fails partway through | broke@5 |",
        "",
        "- `features/failing.feature:3` an operation fails partway through: stopped at line 5 in default before a claim there was judged",
        '  - step "the operation fails": `operation failed on purpose`; record `steps/<id>`',
        "",
        "- commit: `<sha>`",
        "- environment: default",
        "- browser: none launched",
        "- selection: full",
        "- check: skipped (`nuka run --no-check`), so no finding of `nuka check` held this run back",
        "- nukadoko: <version>",
        "- run: <run>",
        "- started <t>, finished <t> (<duration>)",
        "",
        "## Scenarios with no claim",
        "",
        "In each scenario below, no claim on a Then line was judged (held, broken, or unjudged).",
        "",
        "- `features/failing.feature:3` an operation fails partway through: no claim on a Then line was judged in it",
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

  it("writes one summary for the whole run, with one row per criterion", async () => {
    await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    const document = latestRunJson(rootDir);
    const records = document.scenarios as { feature: string; line: number; scenario: string }[];
    expect(records.length).toBeGreaterThan(1);
    const summary = await readRunSummary(rootDir, document.run_id as string);
    const rows = summary.split("\n").filter((line) => /^\| (held|proven|failed) \| /.test(line));
    expect(rows).toHaveLength(records.length);
    for (const record of records) {
      expect(rows.filter((row) => row.includes(`\`${record.feature}:${record.line}\` ${record.scenario} |`))).toHaveLength(1);
    }
  });
});
