import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own progress output end to end (fb5-run-
// output task spec) — everything src/run/progress-log.ts writes, reached
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

describe("nuka run: progress output (fb5-run-output task spec)", () => {
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
    const exitCode = await runCli(["run", "features/passing.feature"], {
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
    const exitCode = await runCli(["run", "features/passing.feature"], {
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
    const exitCode = await runCli(["run", "features/failing.feature"], {
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
    expect(lines[0]).toContain("step 1/3");
    expect(lines[0]).not.toMatch(/FAIL|skip/);
    expect(lines[1]).toContain("step 2/3");
    expect(lines[1]).toContain("FAIL");
    expect(lines[2]).toContain("step 3/3");
    expect(lines[2]).toContain("skip");
  });

  it("every step line carries a duration, so a slow step reads differently from a stuck one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

    for (const line of stepLines(stderr.text())) {
      expect(line).toMatch(/\d+\.\d+s/);
    }
  });

  it("--quiet suppresses step and scenario lines; output locations and the summary still print", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature", "--quiet"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stepLines(stderr.text())).toHaveLength(0);
    expect(scenarioBoundaryLines(stderr.text())).toHaveLength(0);

    const text = stderr.text();
    expect(text).toContain("receipts");
    expect(text).toContain("scenarios");
    expect(text).toContain("allure");
    expect(text).toContain("messages");
    expect(text).toMatch(/1 scenario: 1 passed, 0 failed {2}\(/);
  });

  it("output-location lines name only what this run actually wrote: none for a run that selects zero pickles", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/empty.feature"], {
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
    expect(lines.some((line) => line.startsWith("receipts"))).toBe(false);
    expect(lines.some((line) => line.startsWith("scenarios "))).toBe(false);
    expect(lines.some((line) => line.startsWith("allure"))).toBe(false);
    expect(lines.some((line) => line.startsWith("messages"))).toBe(false);
    // The summary line is unconditional even here (this task's spec,
    // decision 3) — a run that did nothing still gets told so.
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
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const text = stderr.text();
    expect(text).toContain(path.join("reports", "allure"));
    expect(text).toContain(path.join("reports", "messages.ndjson"));
    // The default locations are named nowhere — the config moved the
    // output, this line reports where it actually landed, not where it
    // would have landed by default.
    expect(text).not.toContain(".nukadoko/allure-results");
    expect(text).not.toContain(".nukadoko/messages.ndjson");
  });

  it("stdout carries only the NDJSON scenario records; every non-empty line parses, one per scenario", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/table.feature"], {
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
    const exitCode = await runCli(["run", "features/table.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    // features/table.feature: one scenario binds successfully, the other
    // fails to bind (run.test.ts's own "binds a table..." test covers the
    // record-level detail) — one passed, one failed scenario record.
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("2 scenarios: 1 passed, 1 failed");

    const receiptsLine = nonEmptyLines(stderr.text()).find((line) => line.startsWith("receipts"));
    const scenariosLine = nonEmptyLines(stderr.text()).find((line) => line.startsWith("scenarios"));
    expect(receiptsLine).toBeDefined();
    expect(scenariosLine).toBeDefined();
    // Both scenarios reach their own receipt-writing step (this file's own
    // header) — the first because it passes outright, the second because a
    // binding failure still writes a receipt (docs/spec.md: "an execution
    // that never began" only covers undefined/ambiguous/never-began steps,
    // not a matched step that fails to bind).
    expect(receiptsLine).toMatch(/\b2\s*$/);
    expect(scenariosLine).toMatch(/\b2\s*$/);
  });
});
