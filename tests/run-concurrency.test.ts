import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/run-cli.js";
import { analyzeProject } from "../src/check/analyze.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --concurrency <n>` end to end, against
// tests/fixtures/run-concurrency-project — a pure-step project (no browser,
// no HTTP server) built for this file alone, the same "why a fixture
// project" reasoning tests/run-directory.test.ts already gives for
// tests/fixtures/run-directory-project. `n=1`'s own tests (run.test.ts,
// run-directory.test.ts, and every other run-*.test.ts file) are
// deliberately untouched: this file only ever asserts things that change
// once `--concurrency` is above 1, or that `--concurrency 1` (the default)
// is provably identical to not passing the flag at all.

const RUN_ID_PATTERN = /\brun-\d{8}-\d{6}-[a-z0-9]+\b/g;
const SCN_ID_PATTERN = /\bscn-\d{8}-\d{6}-[a-z0-9]+\b/g;
const STEP_ID_PATTERN = /\bstep-\d{8}-\d{6}-[a-z0-9]+\b/g;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;
// Matches src/run/progress-log.ts's own `formatSummaryDuration` output
// exactly: an optional "<N>h ", an optional "<N>m ", then a mandatory
// "<N>s", all inside parens.
const SUMMARY_DURATION_PATTERN = /\((?:\d+h )?(?:\d+m )?\d+s\)/g;
// A step progress line's own measured duration, src/run/progress-log.ts's
// `formatStepDuration`: one decimal of seconds, so a loaded machine turns
// one run's 0.0s into the other's 0.1s.
const STEP_DURATION_PATTERN = /^( {2}step \d+\/\d+ {2}\S+ {2})\d+\.\ds(?= {2})/gm;

/** Replaces every id/timestamp this test's own two invocations cannot
 * possibly share (each generates its own run id, its own record ids, its
 * own wall-clock timestamps) with a fixed placeholder, so what remains is
 * exactly what a byte-for-byte diff should catch: a real behavior
 * difference, not two invocations simply having run at different moments. */
function normalizeVolatile(text: string): string {
  return text
    .replace(RUN_ID_PATTERN, "<run-id>")
    .replace(SCN_ID_PATTERN, "<scn-id>")
    .replace(STEP_ID_PATTERN, "<step-id>")
    .replace(ISO_TIMESTAMP_PATTERN, "<timestamp>")
    .replace(SUMMARY_DURATION_PATTERN, "(<duration>)")
    .replace(STEP_DURATION_PATTERN, "$1<duration>");
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function replaceFixtureText(filePath: string, oldText: string, newText: string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const updated = source.replace(oldText, newText);
  expect(updated).not.toBe(source);
  await writeFile(filePath, updated, "utf8");
}

async function delayFixtureSteps(rootDir: string): Promise<void> {
  const stepPath = path.join(rootDir, "features/steps/thing-exists.ts");
  await replaceFixtureText(
    stepPath,
    "async run({}, args) {",
    "async run({}, args) {\n    await new Promise((resolve) => setTimeout(resolve, 1000));",
  );
}

/** Makes every scenario's step record its thing's name under `started/`,
 * then wait until the test writes `release`. Seeing every name under
 * `started/` at once is what proves the scenarios were in flight together,
 * with no clock involved. */
async function holdFixtureStepsUntilReleased(rootDir: string): Promise<{ startedDir: string; releasePath: string }> {
  const startedDir = path.join(rootDir, "started");
  const releasePath = path.join(rootDir, "release");
  await mkdir(startedDir);
  await replaceFixtureText(
    path.join(rootDir, "features/steps/thing-exists.ts"),
    "async run({}, args) {",
    [
      "async run({}, args) {",
      '    const { existsSync, writeFileSync } = await import("node:fs");',
      `    writeFileSync(${JSON.stringify(startedDir)} + "/" + args.name, "");`,
      `    while (!existsSync(${JSON.stringify(releasePath)})) {`,
      "      await new Promise((resolve) => setTimeout(resolve, 25));",
      "    }",
    ].join("\n"),
  );
  return { startedDir, releasePath };
}

describe("nuka run --concurrency", () => {
  let rootDir: string;
  let heldRun: { releasePath: string; exit: Promise<number> } | null = null;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    if (heldRun !== null) {
      await writeFile(heldRun.releasePath, "");
      await heldRun.exit;
      heldRun = null;
    }
    await removeTempDir(rootDir);
  });

  it("--concurrency 1 (explicit) is byte-identical to not passing --concurrency at all, once ids/timestamps are normalized", async () => {
    const defaultStdout = createCaptureSink();
    const defaultStderr = createCaptureSink();
    const defaultExit = await runCli(["run", "--no-check", "features/basic/"], {
      rootDir,
      stdout: defaultStdout,
      stderr: defaultStderr,
    });

    const explicitStdout = createCaptureSink();
    const explicitStderr = createCaptureSink();
    const explicitExit = await runCli(["run", "--no-check", "features/basic/", "--concurrency", "1"], {
      rootDir,
      stdout: explicitStdout,
      stderr: explicitStderr,
    });

    expect(defaultExit).toBe(0);
    expect(explicitExit).toBe(0);
    expect(normalizeVolatile(explicitStdout.text())).toBe(normalizeVolatile(defaultStdout.text()));
    expect(normalizeVolatile(explicitStderr.text())).toBe(normalizeVolatile(defaultStderr.text()));
  });

  it("runs both files' worth of scenarios at --concurrency 2: both records on stdout, one shared run_id", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode, stderr.text()).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.feature).sort()).toEqual(["features/basic/a.feature", "features/basic/b.feature"]);
    expect(records.every((r) => r.status === "passed")).toBe(true);
    expect(new Set(records.map((r) => r.run_id)).size).toBe(1);
    expect(stderr.text()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);
  });

  it("uses an absolute messages.output and allure.resultsDir as given at --concurrency 2", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "nukadoko-absolute-export-"));
    try {
      const output = path.join(outside, "messages.ndjson");
      const resultsDir = path.join(outside, "allure-results");
      await writeFile(
        path.join(rootDir, "nukadoko.config.ts"),
        'import { defineConfig } from "./nukadoko-shim.js";\n\n' +
          `export default defineConfig({ messages: { output: ${JSON.stringify(output)} }, allure: { resultsDir: ${JSON.stringify(resultsDir)} } });\n`,
      );

      const stderr = createCaptureSink();
      expect(
        await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr }),
        stderr.text(),
      ).toBe(0);

      expect(existsSync(output)).toBe(true);
      expect(readdirSync(resultsDir).filter((name) => name.endsWith("-result.json"))).toHaveLength(2);
      expect(existsSync(path.join(rootDir, outside))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("runs two file arguments at --concurrency 2 with one shared run_id", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      [
        "run",
        "--no-check",
        "features/basic/b.feature",
        "features/basic/a.feature",
        "--concurrency",
        "2",
      ],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records.map((record) => record.feature).sort()).toEqual([
      "features/basic/a.feature",
      "features/basic/b.feature",
    ]);
    expect(new Set(records.map((record) => record.run_id)).size).toBe(1);
  });

  it("names a failed scenario after the summary at --concurrency 2", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/failure/", "--concurrency", "2", "--quiet"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const lines = nonEmptyLines(stderr.text());
    const summaryIndex = lines.findIndex((line) => line.startsWith("2 scenarios: 1 passed, 1 failed"));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(lines[summaryIndex + 1]).toBe("failed  features/failure/a.feature:3  named concurrent failure");
    expect(lines[summaryIndex + 2]).toBe("  rerun  nuka run features/failure/a.feature:3");
    // A worker's failed step reaches the parent's stderr under --quiet too.
    const failIndex = lines.findIndex((line) => /^ {2}step 1\/1 {2}failed /.test(line));
    expect(lines[failIndex]).toBe("  step 1/1  failed  0.0s  a missing concurrent step");
    expect(lines[failIndex + 1]).toMatch(/^ {6}No step definition matches "a missing concurrent step"/);
  });

  it("a file tagged @nukadoko:serial on its Feature line never runs alongside the others", async () => {
    await delayFixtureSteps(rootDir);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/serial/", "--concurrency", "3"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);

    const serialRecord = records.find((r) => r.feature === "features/serial/z-only.feature");
    const otherRecords = records.filter((r) => r.feature !== "features/serial/z-only.feature");
    expect(serialRecord).toBeDefined();
    expect(otherRecords).toHaveLength(2);

    // The parallel phase exits before the @nukadoko:serial worker starts.
    const latestOtherFinish = Math.max(...otherRecords.map((r) => Date.parse(r.finished_at)));
    expect(Date.parse(serialRecord.started_at)).toBeGreaterThanOrEqual(latestOtherFinish);
  });

  it("a bare @serial Feature tag neither serializes the file nor produces a check finding", async () => {
    const { startedDir, releasePath } = await holdFixtureStepsUntilReleased(rootDir);
    const serialFeaturePath = path.join(rootDir, "features/serial/z-only.feature");
    await replaceFixtureText(serialFeaturePath, "@nukadoko:serial", "@serial");
    const badTagPath = path.join(rootDir, "features/check-badtag/bad.feature");
    await replaceFixtureText(badTagPath, "@nukadoko:serial", "@serial");

    const report = await analyzeProject(rootDir);
    expect(report.errors.filter((issue) => issue.code === "serial-tag-on-scenario")).toHaveLength(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    heldRun = {
      releasePath,
      exit: runCli(["run", "--no-check", "features/serial/", "--concurrency", "3"], {
        rootDir,
        stdout,
        stderr,
      }),
    };

    // A serialized file would start only after the other two finished, and
    // they cannot finish before the release, so this wait would never end
    // and the test's own timeout would fail it.
    while ((await readdir(startedDir)).length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await readdir(startedDir)).sort()).toEqual(["serial-a", "serial-b", "serial-only"]);
    await writeFile(releasePath, "");
    const exitCode = await heldRun.exit;
    heldRun = null;

    expect(exitCode, stderr.text()).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records.map((r) => r.feature).sort()).toEqual([
      "features/serial/a.feature",
      "features/serial/b.feature",
      "features/serial/z-only.feature",
    ]);
  });

  it("a target naming one feature file has nothing to distribute: runs normally and says so on stderr", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/basic/a.feature", "--concurrency", "4"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain("--concurrency has nothing to distribute");
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
  });

  it("names the file a crashed worker never reported a record for, and fails the run", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/crash/", "--concurrency", "2"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).not.toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    // The healthy file's own record still made it through, forwarded by
    // the parent exactly as any other worker's record would be — only the
    // crashed file is missing.
    expect(records.map((r) => r.feature)).toEqual(["features/crash/a.feature"]);

    const failureLine = stderr
      .text()
      .split("\n")
      .find((line) => line.includes("A worker exited without writing any record for"));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("features/crash/z-crash.feature");
    expect(failureLine).not.toContain("features/crash/a.feature");
  });

  it("refuses a non-integer or sub-1 --concurrency in setup, before writing anything", async () => {
    for (const value of ["0", "-1", "2.5", "banana"]) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--no-check", "features/basic/", "--concurrency", value], {
        rootDir,
        stdout,
        stderr,
      });
      expect(exitCode, `--concurrency ${value}`).not.toBe(0);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toMatch(/--concurrency/);
    }
  });

  it("nuka check reports serial-tag-on-scenario for @nukadoko:serial on a Scenario line", async () => {
    const report = await analyzeProject(rootDir);
    const badTagIssues = report.errors.filter((issue) => issue.code === "serial-tag-on-scenario");
    expect(badTagIssues).toHaveLength(1);
    expect(badTagIssues[0]!.file).toBe("features/check-badtag/bad.feature");
    expect(badTagIssues[0]!.message).toContain("Feature line");
  });
});
