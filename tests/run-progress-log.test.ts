import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own progress output end to end —
// everything src/run/progress-log.ts writes, reached
// through cli/run.ts's own wiring rather than by calling that module
// directly, since the whole point is what a real invocation's stderr looks
// like. Reuses run-project (run.test.ts's own fixture): features/passing.
// feature (two passing steps), features/failing.feature (pass, fail, skip),
// features/table.feature (one passing scenario, one that fails to bind),
// and features/empty.feature (zero pickles) already cover every shape this
// file needs without a new fixture.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function stepLines(stderrText: string): string[] {
  return nonEmptyLines(stderrText).filter((line) => /^ {2}step \d+\/\d+ {2}/.test(line));
}

function scenarioBoundaryLines(stderrText: string): string[] {
  return nonEmptyLines(stderrText).filter((line) => /^scenario \d+\/\d+ {2}/.test(line));
}

function failedScenarioLines(stderrText: string): string[] {
  return nonEmptyLines(stderrText).filter((line) => line.startsWith("failed  "));
}

describe("nuka run: progress output", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes exactly one step line per pickle step, never duplicated", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const lines = stepLines(stderr.text());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("step 1/2");
    expect(lines[1]).toContain("step 2/2");
    // Distinct positions, not the same line written twice under two
    // different-looking guises.
    expect(new Set(lines).size).toBe(2);
  });

  it("also writes one scenario boundary line, naming the feature path, line, and scenario name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const lines = scenarioBoundaryLines(stderr.text());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("scenario 1/1");
    expect(lines[0]).toContain("features/passing.feature:3");
    expect(lines[0]).toContain("create and check a thing");
  });

  it("a failed step's own line is recognizable as failed, distinct from passed/skipped", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const lines = stepLines(stderr.text());
    expect(lines).toHaveLength(3);
    // First step passed, second failed (the scenario's own trigger), third
    // never ran (skipped once the second failed) — run.test.ts's own
    // "skips every step after one fails" test asserts the same shape on the
    // scenario record; this only checks the progress line reads the same
    // way. Each status word is unique, so no two of the three lines could
    // be mistaken for each other.
    expect(lines[0]).toMatch(/^ {2}step 1\/3 {2}passed {2}/);
    expect(lines[1]).toMatch(/^ {2}step 2\/3 {2}failed {2}/);
    expect(lines[2]).toMatch(/^ {2}step 3\/3 {2}skipped {2}/);
  });

  it("every step line carries a duration, so a slow step reads differently from a stuck one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["run", "--records", "--no-check", "features/passing.feature"], { rootDir, stdout, stderr });

    for (const line of stepLines(stderr.text())) {
      expect(line).toMatch(/\d+\.\d+s/);
    }
  });

  it("names each failed scenario after the summary", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const lines = nonEmptyLines(stderr.text());
    const summaryIndex = lines.findIndex((line) => line.startsWith("1 scenario: 0 passed, 1 failed"));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(lines[summaryIndex + 1]).toBe(
      "failed\tscenario-failed\tfeatures/failing.feature:3\tan operation fails partway through: operation failed on purpose",
    );
  });

  // Durations and step record ids differ on every run; everything else on
  // stderr is fixed, so the rest is compared literally.
  function normalizeRun(stderrText: string): string {
    return stderrText
      .replace(/\d+\.\d+s/g, "<d>s")
      .replace(/\(\d+(h|m|s)[^)]*\)/g, "(<duration>)")
      .replaceAll(path.sep, "/")
      .replace(/runs\/run-[a-z0-9-]+/g, "runs/<run>")
      .replace(/steps\/step-[a-z0-9-]+/g, "steps/<id>")
      .replace(/messages\.run-[a-z0-9-]+\.ndjson/g, "messages.<run>.ndjson");
  }

  it("names a failed step's error and step record, and how to rerun the scenario", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failing.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(normalizeRun(stderr.text())).toBe(
      [
        "scenario 1/1  features/failing.feature:3  an operation fails partway through",
        "  step 1/3  passed  <d>s  a thing \"widget\" exists",
        "  step 2/3  failed  <d>s  the operation fails",
        "      operation failed on purpose",
        "      record  .nukadoko/runs/<run>/steps/<id>",
        "  step 3/3  skipped  <d>s  this step never runs",
        "steps     .nukadoko/runs/<run>/steps/  2",
        "allure    .nukadoko/export/allure-results/",
        "messages  .nukadoko/export/messages.<run>.ndjson",
        "summary   .nukadoko/runs/<run>/summary.md",
        "run       .nukadoko/runs/<run>/run.json",
        "1 scenario: 0 passed, 1 failed  (<duration>)",
        "failed\tscenario-failed\tfeatures/failing.feature:3\tan operation fails partway through: operation failed on purpose",
        "  do: nuka run features/failing.feature:3",
        "",
      ].join("\n"),
    );
  });

  it("the do line carries --env, so the scenario reruns where it failed", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\nexport default defineConfig({ environments: { staging: {} } });\n',
    );
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failing.feature", "--env", "staging"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const lines = nonEmptyLines(stderr.text());
    const failedIndex = lines.findIndex((line) => line.startsWith("failed\tscenario-failed\t"));
    expect(lines[failedIndex + 1]).toBe("  do: nuka run features/failing.feature:3 --env staging");
  });

  it("writes no failed scenario line when every scenario passes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/passing.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(failedScenarioLines(stderr.text())).toHaveLength(0);
  });

  it("output-location lines name only what this run actually wrote: none for a run that selects zero pickles", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/empty.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    // None of the four output-location rows (each its own line, starting
    // with its own label) — checked by line start, not by substring: the
    // summary line legitimately contains the word "scenarios" as part of
    // "0 scenarios: ...", which a bare `.not.toContain("scenarios")` would
    // wrongly flag.
    const lines = nonEmptyLines(stderr.text());
    expect(lines.some((line) => line.startsWith("steps"))).toBe(false);
    expect(lines.some((line) => line.startsWith("scenarios "))).toBe(false);
    expect(lines.some((line) => line.startsWith("allure"))).toBe(false);
    expect(lines.some((line) => line.startsWith("messages"))).toBe(false);
    // The summary line is unconditional even here — a run that did nothing
    // still gets told so.
    expect(stderr.text()).toContain("0 scenarios: 0 passed, 0 failed");
  });

  it("an output-location line names the moved path once config.allure.resultsDir/messages.output relocate it", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        "",
        "export default defineConfig({",
        '  allure: { resultsDir: "reports/allure" },',
        '  messages: { output: "reports/messages.ndjson" },',
        "});",
        "",
      ].join("\n"),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const text = stderr.text();
    expect(text).toContain(path.join("reports", "allure"));
    // The messages row names this run's own run-id-suffixed file inside
    // the moved directory, not the bare configured name (this file's own
    // "run-id-suffixed" test above covers why) — checked by directory plus
    // id, not by the exact "messages.ndjson" name, which a suffixed file
    // never contains contiguously.
    const runId = latestRunJson(rootDir).run_id as string;
    expect(text).toContain(path.join("reports", `messages.${runId}.ndjson`));
    // The default locations are named nowhere — the config moved the
    // output, this line reports where it actually landed, not where it
    // would have landed by default.
    expect(text).not.toContain(".nukadoko/export/allure-results");
    expect(text).not.toContain(".nukadoko/export/messages.ndjson");
  });

  it("the messages output-location line names this run's own run-id-suffixed file, not the stable configured path", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const runId = latestRunJson(rootDir).run_id as string;
    const messagesLine = nonEmptyLines(stderr.text()).find((line) => line.startsWith("messages"));
    expect(messagesLine).toBeDefined();
    // A concurrent run can overwrite the stable configured path before a
    // reader gets to it (this file's own header) — checking for a fixed
    // "messages.ndjson" substring alone would pass even for the stable
    // path, since a run-id-suffixed name never contains it contiguously
    // (the id sits between the basename and the extension), so this
    // asserts the id actually named is *this* run's own.
    expect(messagesLine).toContain(`messages.${runId}.ndjson`);
  });

  it("stdout carries only each scenario's run.json entry under --records; every non-empty line parses, one per scenario", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/table.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    // Progress output is real and non-empty (proof this test isn't passing
    // by accident because nothing was written anywhere).
    expect(stderr.text().length).toBeGreaterThan(0);
    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("the summary line's numbers match this run's own actual results", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/table.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    // features/table.feature: one scenario binds successfully, the other
    // fails to bind (run.test.ts's own "binds a table..." test covers the
    // record-level detail) — one passed, one failed scenario record.
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("2 scenarios: 1 passed, 1 failed");

    const stepsLine = nonEmptyLines(stderr.text()).find((line) => line.startsWith("steps"));
    expect(stepsLine).toBeDefined();
    // Both scenarios reach their own step-record-writing step (this file's
    // own header) — the first because it passes outright, the second because
    // a binding failure still writes a step record (docs/spec.md: "an
    // execution that never began" only covers undefined/ambiguous/never-began
    // steps, not a matched step that fails to bind).
    expect(stepsLine).toMatch(/\b2\s*$/);
    expect(latestRunJson(rootDir).counts).toEqual({ scenarios: 2, passed: 1, failed: 1 });
  });
});
