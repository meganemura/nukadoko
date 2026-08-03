import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own pre-execution guard (m6b-from-check task
// spec, item 2; docs/spec.md "Chaining steps": "`nuka run`, before it
// executes that scenario, so forgetting to check is not punished with a
// browser session") — the same judgment tests/check-from-order.test.ts
// already covers for `nuka check` (src/check/from-order.ts's own header:
// one function, two callers), exercised here through the executor instead:
// a violating scenario never gets any of its steps a receipt (this is what
// "no browser session is ever opened" actually reduces to — a step's own
// `run` is the only place `ctx.page()` could be called, and none of them run
// here), while every other scenario in the same `nuka run` invocation is
// unaffected. Also covers this task's other deliverable: `nuka run` now
// shares `nuka do`'s existing structural `from` refusal
// (src/step/validate-from.ts's `validateStepFrom`), for a step this run's
// own selected feature actually binds — scoped that way on purpose (this
// task's spec: "実行に入る前に一度だけ", cli/run.ts's own header) so an
// unrelated, never-bound step's own broken `from` elsewhere in the project
// (this same fixture's `archive-project-unregistered-from`) cannot fail a
// run that never touches it.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: from's scenario-order guard", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails the scenario before any step runs when the upstream is never bound", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:11"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    // `receipt: null` — unlike this exact scenario's pre-m6b behavior (this
    // step used to actually run and fail args validation with a real
    // receipt; m6a-from-core's own comment anticipated this: "m6b が入れば、
    // この失敗は実行前に捕まるようになる") — this step's own `run` is never
    // called at all now, so no browser session could ever have been opened.
    expect(record.steps[0].receipt).toBeNull();
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("archive-project");
    expect(record.steps[0].error.message).toContain("create-project");
    expect(record.steps[0].error.message).toContain("never bound anywhere in this scenario");
  });

  it("fails the scenario before any step runs when the upstream is bound only after this line", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:23"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].receipt).toBeNull();
    expect(record.steps[0].error.message).toContain("only at or after this line");
    // The `create-project` line itself is textually *after* the violation,
    // but it never runs either (this task's spec: "実行せずに失敗させる") —
    // `"skipped"`, not `"passed"`, and no receipt.
    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[1].receipt).toBeNull();
  });

  it("every other scenario in the same feature file still runs normally", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature"], { rootDir, stdout, stderr });

    // Some scenarios in this file fail (the two above), so this whole
    // invocation's own exit code is non-zero — that must not be confused
    // with every scenario failing.
    expect(exitCode).toBe(1);

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const byLine = new Map(records.map((record) => [record.line, record]));

    // The scenario-order violations, unaffected by running the whole file
    // instead of one `:line` at a time.
    expect(byLine.get(11).status).toBe("failed");
    expect(byLine.get(23).status).toBe("failed");

    // Every other scenario — including ones both before and after the
    // violations in file order — still executed for real, receipts and all.
    for (const line of [3, 7, 14, 19, 27, 30]) {
      const record = byLine.get(line);
      expect(record, `scenario at line ${line}`).toBeDefined();
      expect(record.status, `scenario at line ${line}`).toBe("passed");
      for (const step of record.steps) {
        expect(step.receipt, `scenario at line ${line}, step "${step.text}"`).not.toBeNull();
      }
    }
  });

  it("refuses the whole run, before any scenario record is written, when a bound step's own from is structurally broken", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/broken-from-bound.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    // Setup-phase fatal, same family as ConfigError/DuplicateStepError (this
    // task's spec: "m6a が積み残した配線を1つ閉じること") — no scenario
    // record line is ever printed.
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("broken-from-bound");
    expect(stderr.text()).toContain("never registered");
  });
});
