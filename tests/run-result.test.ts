import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { buildRunResult, type RunResultScenario } from "../src/record/run-result.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json, the run's machine-readable result, as `nuka run`
// writes it and as `nuka run --json` prints it.

function onlyRunId(rootDir: string): string {
  const runs = readdirSync(path.join(rootDir, ".nukadoko", "records", "runs"));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function readRunJson(rootDir: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(rootDir, ".nukadoko", "records", "runs", runId, "run.json"), "utf8"));
}

describe("nuka run: run.json", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names every scenario of a mixed run with its record and the rerun command stderr prints", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failure/"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const runId = onlyRunId(rootDir);
    const result = readRunJson(rootDir, runId);
    const records = stdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failed = records.find((record) => record.status === "failed")!;
    const passed = records.find((record) => record.status === "passed")!;

    expect(result).toEqual({
      schema_version: 1,
      nukadoko: readOwnVersion(),
      run_id: runId,
      verdict: "failed",
      started_at: expect.any(String),
      finished_at: expect.any(String),
      environment: "default",
      counts: { scenarios: 2, passed: 1, failed: 1 },
      scenarios: expect.arrayContaining([
        {
          scenario_record_id: failed.scenario_record_id,
          feature: "features/failure/a.feature",
          line: 3,
          scenario: "named concurrent failure",
          status: "failed",
          record: path.join(".nukadoko", "records", "scenarios", failed.scenario_record_id, "record.json"),
          rerun: "nuka run features/failure/a.feature:3",
        },
        {
          scenario_record_id: passed.scenario_record_id,
          feature: "features/failure/b.feature",
          line: 3,
          scenario: "concurrent pass",
          status: "passed",
          record: path.join(".nukadoko", "records", "scenarios", passed.scenario_record_id, "record.json"),
          rerun: "nuka run features/failure/b.feature:3",
        },
      ]),
      summary: path.join(".nukadoko", "records", "runs", runId, "summary.md"),
    });
    expect(result.scenarios).toHaveLength(2);
    for (const scenario of result.scenarios) expect(existsSync(path.join(rootDir, scenario.record))).toBe(true);
    expect(stderr.text()).toContain("  rerun  nuka run features/failure/a.feature:3\n");
    expect(stderr.text()).toContain(`run       ${path.join(".nukadoko", "records", "runs", runId, "run.json")}\n`);
  });

  it("prints run.json under --json as the one document on stdout, also at --concurrency 2", async () => {
    for (const extra of [[], ["--concurrency", "2"]]) {
      await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--no-check", "--json", ...extra, "features/basic/"], { rootDir, stdout, stderr });

      expect(exitCode, stderr.text()).toBe(0);
      const printed = JSON.parse(stdout.text());
      expect(printed).toEqual(readRunJson(rootDir, onlyRunId(rootDir)));
      expect([printed.verdict, printed.counts]).toEqual(["passed", { scenarios: 2, passed: 2, failed: 0 }]);
      expect(printed.scenarios.map((s: { feature: string }) => s.feature).sort()).toEqual([
        "features/basic/a.feature",
        "features/basic/b.feature",
      ]);
    }
  });

  it("counts what its scenarios say, for any mix of outcomes", () =>
    hegel.test((tc) => {
      const statuses = tc.draw(gs.arrays(gs.sampledFrom(["passed", "failed"] as const), { maxSize: 12 }));
      const scenarios: RunResultScenario[] = statuses.map((status, index) => ({
        scenario_record_id: `scn-${index}`,
        feature: "features/a.feature",
        line: index + 1,
        scenario: `s${index}`,
        status,
        record: `.nukadoko/records/scenarios/scn-${index}/record.json`,
        rerun: `nuka run features/a.feature:${index + 1}`,
      }));
      const result = buildRunResult({
        nukadoko: "0.0.0-test",
        runId: "run-1",
        verdict: "failed",
        startedAt: new Date(0),
        finishedAt: new Date(1),
        environment: "default",
        scenarios,
        summary: null,
      });
      const failed = statuses.filter((status) => status === "failed").length;
      expect(result.counts).toEqual({ scenarios: statuses.length, passed: statuses.length - failed, failed });
      expect(result.scenarios).toEqual(scenarios);
    }));
});
