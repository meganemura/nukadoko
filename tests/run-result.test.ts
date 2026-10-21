import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { countScenarios, readRunResult } from "../src/record/run-result.js";
import { renderRunSummary } from "../src/run/run-summary.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json, the run's machine-readable result, as `nuka run`
// writes it and as `nuka run --json` prints it.

function onlyRunId(rootDir: string): string {
  const runs = readdirSync(path.join(rootDir, ".nukadoko", "runs"));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function readRunJson(rootDir: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(rootDir, ".nukadoko", "runs", runId, "run.json"), "utf8"));
}

describe("nuka run: run.json", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names the commit, the condition, every scenario with its steps, and how to rerun a failed one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/failure/"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const runId = onlyRunId(rootDir);
    const result = readRunJson(rootDir, runId);
    const passedStep = result.scenarios.find((s: { status: string }) => s.status === "passed").steps[0];

    expect(result).toEqual({
      schema_version: 2,
      nukadoko: readOwnVersion(),
      command: "run",
      verdict: "failed",
      findings: [
        {
          severity: "failed",
          code: "scenario-failed",
          file: "features/failure/a.feature",
          line: 3,
          message: 'named concurrent failure: No step definition matches "a missing concurrent step"',
          do: "nuka run features/failure/a.feature:3",
        },
      ],
      run_id: runId,
      run_dir: `.nukadoko/runs/${runId}`,
      started_at: expect.any(String),
      finished_at: expect.any(String),
      // The fixture copy sits inside this repository's own working tree.
      commit: { sha: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: expect.any(Boolean) },
      environments: [{ name: "default", target_version: null, base_url: null }],
      selection: "full",
      counts: { scenarios: 2, passed: 1, failed: 1, not_run: 0 },
      scenarios: [
        {
          scenario_record_id: expect.stringMatching(/^scn-/),
          feature: "features/failure/a.feature",
          line: 3,
          scenario: "named concurrent failure",
          environment: "default",
          status: "failed",
          started_at: expect.any(String),
          finished_at: expect.any(String),
          steps: [
            {
              line: 4,
              text: "a missing concurrent step",
              step: null,
              status: "undefined",
              step_record_id: null,
              record: null,
              error: { kind: null, message: 'No step definition matches "a missing concurrent step"' },
            },
          ],
          hooks: [],
          do: "nuka run features/failure/a.feature:3",
          criteria: { changed_since: null },
        },
        {
          scenario_record_id: expect.stringMatching(/^scn-/),
          feature: "features/failure/b.feature",
          line: 3,
          scenario: "concurrent pass",
          environment: "default",
          status: "passed",
          started_at: expect.any(String),
          finished_at: expect.any(String),
          steps: [
            {
              line: 4,
              text: 'a thing "parallel" exists',
              step: "thing-exists",
              status: "passed",
              step_record_id: passedStep.step_record_id,
              record: path.join("steps", passedStep.step_record_id),
              mutates: true,
              observed: { http_reads: null, http_writes: null, processes: null },
            },
          ],
          hooks: [],
          criteria: { changed_since: null },
        },
      ],
      verdicts: [
        {
          feature: "features/failure/a.feature",
          line: 3,
          scenario: "named concurrent failure",
          environment: "default",
          verdict: "failed",
          executions: 1,
          passed: 0,
        },
        {
          feature: "features/failure/b.feature",
          line: 3,
          scenario: "concurrent pass",
          environment: "default",
          verdict: "passed",
          executions: 1,
          passed: 1,
        },
      ],
      since: null,
    });
    // Paths in run.json are relative to the run directory.
    expect(existsSync(path.join(rootDir, ".nukadoko", "runs", runId, passedStep.record, "record.json"))).toBe(true);
    // The --records stream is the same scenario entries, one per line.
    expect(
      stdout
        .text()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(result.scenarios);
    // No scenario record file is written: run.json holds the scenario, and
    // a scenarios directory no scenario wrote evidence into is removed.
    expect(existsSync(path.join(rootDir, ".nukadoko", "runs", runId, "scenarios"))).toBe(false);
    expect(stderr.text()).toContain("  do: nuka run features/failure/a.feature:3\n");
    expect(stderr.text()).toContain(`run       ${path.join(".nukadoko", "runs", runId, "run.json")}\n`);
  });

  it("is the one source of summary.md: the summary renders again, byte for byte, from run.json read off disk", async () => {
    const exitCode = await runCli(["run", "--no-check", "features/"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const runDir = path.join(rootDir, ".nukadoko", "runs", onlyRunId(rootDir));
    const document = readRunResult(path.join(runDir, "run.json"));
    expect(document).not.toBe(null);
    expect(renderRunSummary(document!)).toBe(readFileSync(path.join(runDir, "summary.md"), "utf8"));
  });

  it("prints run.json's fields in the --json envelope, the one document on stdout, also at --concurrency 2", async () => {
    for (const extra of [[], ["--concurrency", "2"]]) {
      await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--no-check", "--json", ...extra, "features/basic/"], { rootDir, stdout, stderr });

      expect(exitCode, stderr.text()).toBe(0);
      const printed = JSON.parse(stdout.text());
      // The envelope carries run.json's fields beside its own five.
      expect(printed).toEqual({ ...readRunJson(rootDir, onlyRunId(rootDir)), schema_version: 2, command: "run", findings: [] });
      expect([printed.verdict, printed.counts]).toEqual(["passed", { scenarios: 2, passed: 2, failed: 0, not_run: 0 }]);
      expect(printed.scenarios.map((s: { feature: string }) => s.feature).sort()).toEqual([
        "features/basic/a.feature",
        "features/basic/b.feature",
      ]);
    }
  });

  it("writes nothing on stderr under --json, for a failed run too, at either concurrency", async () => {
    for (const extra of [[], ["--concurrency", "2"]]) {
      await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--no-check", "--json", ...extra, "features/failure/"], { rootDir, stdout, stderr });

      expect(stderr.text()).toBe("");
      expect(exitCode).toBe(1);
      const printed = JSON.parse(stdout.text());
      expect([printed.verdict, printed.counts]).toEqual(["failed", { scenarios: 2, passed: 1, failed: 1, not_run: 0 }]);
      expect(printed.scenarios.find((s: { status: string }) => s.status === "failed").do).toBe(
        "nuka run features/failure/a.feature:3",
      );
    }
  });

  it("counts what its scenarios say, and the cells that never ran, for any mix of outcomes", () =>
    hegel.test((tc) => {
      const statuses = tc.draw(gs.arrays(gs.sampledFrom(["passed", "failed"] as const), { maxSize: 12 }));
      const cells = tc.draw(gs.arrays(gs.sampledFrom(["passed", "failed", "not-run"] as const), { maxSize: 12 }));
      const failed = statuses.filter((status) => status === "failed").length;
      expect(
        countScenarios(
          statuses.map((status) => ({ status })),
          cells.map((verdict) => ({ verdict })),
        ),
      ).toEqual({
        scenarios: statuses.length,
        passed: statuses.length - failed,
        failed,
        not_run: cells.filter((verdict) => verdict === "not-run").length,
      });
    }));
});
