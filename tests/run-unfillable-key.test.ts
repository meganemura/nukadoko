import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s pre-execution guard side of the
// unfillable-key check — the same judgment tests/check-unfillable-key.test.ts
// already covers for `nuka check` (src/check/unfillable-key.ts's own
// header: one function, two callers), exercised here through the executor
// instead. A scenario with a statically-unfillable required key never gets
// its own step's `run` called at all (this fixture is a pure-step project —
// no browser anywhere — so "no browser session is ever opened" reduces to
// exactly this: `step_record_id: null`, the same "never began" shape
// src/run/run-scenario.ts's existing `from`-order guard already produces), while every
// other scenario in the same feature file still executes for real.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: unfillable required args key guard", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("unfillable-key-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails the violating scenario before its step ever runs, with no step record", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/run-guard.feature:3"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].step_record_id).toBeNull();
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("unfillable");
    expect(record.steps[0].error.message).toContain("serial");
  });

  it("every other scenario in the same feature file still runs normally, step records and all", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/run-guard.feature"], { rootDir, stdout, stderr });

    // The one violating scenario fails this whole invocation's exit code —
    // that must not be confused with every scenario failing.
    expect(exitCode).toBe(1);

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const byLine = new Map(records.map((record) => [record.line, record]));

    expect(byLine.get(3).status).toBe("failed");
    expect(byLine.get(3).steps[0].step_record_id).toBeNull();

    for (const line of [6, 9]) {
      const record = byLine.get(line);
      expect(record, `scenario at line ${line}`).toBeDefined();
      expect(record.status, `scenario at line ${line}`).toBe("passed");
      for (const step of record.steps) {
        expect(step.step_record_id, `scenario at line ${line}, step "${step.text}"`).not.toBeNull();
      }
    }
  });
});
