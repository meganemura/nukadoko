import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: a `"process"`-
// scope fixture is built exactly once across two scenarios in the same
// `nuka run` invocation, and reused (never rebuilt) by the second. Against
// tests/fixtures/user-fixtures-project's `seededDb` fixture ({ scope:
// "process" }), whose own value carries a module-level build counter — both
// scenarios in features/process-scope.feature report it as part of their own
// `result`, so this test reads it straight off each scenario's own step record
// rather than a side-channel file (unlike tests/run-fixture-teardown.test.ts,
// this is squarely inside one `nuka run` invocation, so the ordinary
// "the tool measured it" step record path already carries the proof).

describe("nuka run: process-scope fixture is built once, reused by a later scenario", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("user-fixtures-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("both scenarios read the same seededDb build count", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/process-scope.feature"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(exitCode).toBe(0);

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { steps: { step_record_id: string }[] });
    expect(records).toHaveLength(2);

    // Each scenario's own step record is written to .nukadoko/records/steps/<id>/
    // record.json; read both back to check `result.count` and `fixtures`.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    async function readStepRecord(recordId: string): Promise<any> {
      const text = await fs.readFile(
        path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json"),
        "utf8",
      );
      return JSON.parse(text);
    }

    const first = await readStepRecord(records[0]!.steps[0]!.step_record_id);
    const second = await readStepRecord(records[1]!.steps[0]!.step_record_id);

    // The build count seededDb's own setup incremented is 1 both times —
    // it was only ever actually built once.
    expect(first.result.count).toBe(1);
    expect(second.result.count).toBe(1);

    // The step record's own `fixtures` entry says so directly too: the
    // first scenario's step built it fresh
    // (`reused: false`, `setup_ms`/`at` present); the second's step
    // received the already-built instance (`reused: true`, no `setup_ms`/
    // `at` — their absence is what tells "reused, hence fast" apart from
    // "measured 0ms").
    expect(first.fixtures).toEqual([
      { name: "seededDb", scope: "process", reused: false, setup_ms: expect.any(Number), at: expect.any(String) },
    ]);
    expect(second.fixtures).toEqual([{ name: "seededDb", scope: "process", reused: true }]);
  });
});
