import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka check` reports capture-type-mismatch for exactly the
// captures whose JS type cannot satisfy the args schema, and `nuka run`
// agrees. Every step in the fixture is named bad-* (always fails args
// validation) or ok-* (passes, including the near misses check stays silent
// on: a coerce, a union, a preprocess, a custom type, a transform whose input
// side matches).

interface CheckIssue {
  code: string;
  step?: string;
}

describe("nuka check: capture type against args schema", () => {
  let tempDir: string | undefined;
  afterEach(async () => {
    if (tempDir) await removeTempDir(tempDir);
    tempDir = undefined;
  });

  it("reports the bad-* steps and no others", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-capture-types-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text()) as { errors: CheckIssue[]; warnings: CheckIssue[] };

    expect(exitCode).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(report.errors.map((issue) => issue.code)).toEqual(Array(11).fill("capture-type-mismatch"));
    expect(report.errors.map((issue) => issue.step)).toEqual([
      "bad-anon-number",
      "bad-bigdecimal-number",
      "bad-biginteger-number",
      "bad-byte-string",
      "bad-double-string",
      "bad-int-boolean",
      "bad-int-optional-string",
      "bad-int-transform",
      "bad-long-string",
      "bad-short-string",
      "bad-word-boolean",
    ]);
  });

  it("names the captured and the declared type in the message", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-capture-types-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text()) as { errors: { step: string; message: string }[] };
    const messages = Object.fromEntries(report.errors.map((issue) => [issue.step, issue.message]));

    expect(messages["bad-int-boolean"]).toBe(
      'Step "bad-int-boolean" pattern "bad-int-boolean {v:int}" binds key "v" as {int} (a number), but args declares "v" as a boolean',
    );
    expect(messages["bad-anon-number"]).toBe(
      'Step "bad-anon-number" pattern "bad-anon-number {v:}" binds key "v" as the anonymous type (a string), but args declares "v" as a number',
    );
  });

  it("agrees with nuka run: every bad-* scenario fails and every ok-* scenario passes", async () => {
    tempDir = await copyFixtureToTempDir("check-capture-types-project");
    const stdout = createCaptureSink();
    await runCli(["run", "--no-check", "features/capture-types.feature"], {
      rootDir: tempDir,
      stdout,
      stderr: createCaptureSink(),
    });
    const rows = stdout
      .text()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { scenario: string; status: string });

    expect(rows).toHaveLength(24);
    for (const row of rows) {
      expect([row.scenario, row.status]).toEqual([row.scenario, row.scenario.startsWith("bad-") ? "failed" : "passed"]);
    }
  });

  it("nuka run writes a bound bigint into the step record as its decimal string", async () => {
    tempDir = await copyFixtureToTempDir("check-capture-types-project");
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/capture-types.feature"], {
      rootDir: tempDir,
      stdout,
      stderr: createCaptureSink(),
    });
    const rows = stdout
      .text()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { scenario: string; steps: { step_record_id: string }[] });
    const row = rows.find((candidate) => candidate.scenario === "ok-biginteger-bigint");
    const recordPath = path.join(tempDir, ".nukadoko", "records", "steps", row!.steps[0]!.step_record_id, "record.json");
    const stepRecord = JSON.parse(await readFile(recordPath, "utf8")) as { status: string; args: unknown };

    expect(exitCode).toBe(1);
    expect(stepRecord.status).toBe("passed");
    expect(stepRecord.args).toEqual({ v: "123456789012345678901234567890" });
  });
});
