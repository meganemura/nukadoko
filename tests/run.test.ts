import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: `nuka run` end to end against run-project — a pure-step
// fixture (no browser, no HTTP server) covering matching/skip/record
// mechanics on their own. Browser evidence,
// `--session` propagation, and secret redaction each get their own file
// (run-browser.test.ts, run-session.test.ts, run-secrets.test.ts) since they
// need their own fixture project and/or a real server or chromium.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs a pure-step scenario to completion: record + step records + JSONL stdout + exit 0", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.feature).toBe("features/passing.feature");
    expect(record.scenario).toBe("create and check a thing");
    expect(record.line).toBe(3);
    expect(record.status).toBe("passed");
    expect(record.environment).toBe("default");
    expect(record.session).toBeNull();
    expect(record.steps).toHaveLength(2);
    for (const step of record.steps) {
      expect(step.status).toBe("passed");
      expect(typeof step.record).toBe("string");
      expect(step.error).toBeUndefined();
    }
    expect(record.evidence.dir).toBe(path.join(".nukadoko", "records", "scenarios", record.scenario_id));
    expect(record.evidence.screenshots).toEqual([]);
    expect(record.evidence.trace).toBeUndefined();

    const recordPath = path.join(rootDir, record.evidence.dir, "record.json");
    expect(existsSync(recordPath)).toBe(true);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);

    for (const step of record.steps) {
      const stepRecord = await readStepRecord(rootDir, step.record);
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.kind).toBe("run");
      expect(stepRecord.scenario).toBe(record.scenario_id);
      expect(stepRecord.environment).toBe("default");
      expect(stepRecord.session).toBeNull();
      // A pure step makes no network calls at all: `observed` is still
      // always present, at zero.
      expect(stepRecord.observed).toEqual({ http_reads: 0, http_writes: 0 });
    }

    // A typed step's step record carries its own declared `mutates`
    // verbatim — `thing-exists` (Given position) declares `mutates: true`,
    // `the-thing-exists` (Then position) declares `mutates: false`.
    const firstStepRecord = await readStepRecord(rootDir, record.steps[0].record);
    expect((firstStepRecord as { mutates: unknown }).mutates).toBe(true);
    const secondStepRecord = await readStepRecord(rootDir, record.steps[1].record);
    expect((secondStepRecord as { mutates: unknown }).mutates).toBe(false);
  });

  it("skips every step after one fails, recording each step's own status; exit 1", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/failing.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(3);

    const [first, second, third] = record.steps;
    expect(first.status).toBe("passed");
    expect(typeof first.record).toBe("string");

    expect(second.status).toBe("failed");
    expect(typeof second.record).toBe("string");
    expect(second.error.message).toBe("operation failed on purpose");
    const failedStepRecord = await readStepRecord(rootDir, second.record);
    expect(failedStepRecord.status).toBe("failed");
    expect((failedStepRecord as { error: { message: string } }).error.message).toBe(
      "operation failed on purpose",
    );
    // A typed step's own throw classifies as the catch-all "step_error".
    expect((failedStepRecord as { error: { kind: string } }).error.kind).toBe("step_error");

    expect(third.status).toBe("skipped");
    expect(third.record).toBeNull();
    expect(third.error).toBeUndefined();

    // Only the two steps that actually began execution wrote a step record.
    const stepsDir = path.join(rootDir, ".nukadoko", "records", "steps");
    expect(await readdir(stepsDir)).toHaveLength(2);
  });

  it("an undefined step gets no step record and fails the scenario, naming the unmatched text", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/undefined.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("undefined");
    expect(record.steps[1].record).toBeNull();
    expect(record.steps[1].error.message).toContain(
      'No step definition matches "this text matches no step definition at all"',
    );
    expect(record.steps[1].error.message).toContain("nuka scaffold");
  });

  it("an ambiguous step gets no step record and names every step that matched", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/ambiguous.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("ambiguous");
    expect(record.steps[0].record).toBeNull();
    expect(record.steps[0].error.message).toContain("ambiguous-a");
    expect(record.steps[0].error.message).toContain("ambiguous-b");
  });

  // Then-position measured enforcement (a declared-mutating step's *actual*
  // network writes, not the declaration itself) needs a real HTTP server, so
  // it lives in its own file — tests/observed.test.ts — following this
  // file's own split-by-evidence-type convention (see this file's header
  // comment).

  it("binds a table to the one unconsumed key; a second scenario violates that rule and still writes a failed step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/table.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);

    const [ok, bad] = records;
    expect(ok.scenario).toBe("a table binds successfully");
    expect(ok.status).toBe("passed");
    const okStepRecord = await readStepRecord(rootDir, ok.steps[0].record);
    expect(okStepRecord.args).toEqual({
      a: "a",
      rest: [
        ["col1", "col2"],
        ["x", "y"],
      ],
    });

    expect(bad.scenario).toBe("a table fails to bind");
    expect(bad.status).toBe("failed");
    expect(bad.steps[0].status).toBe("failed");
    expect(typeof bad.steps[0].record).toBe("string");
    expect(bad.steps[0].error.message).toContain("2 args keys are left unconsumed");
    expect(bad.steps[0].error.message).toContain("rest");
    expect(bad.steps[0].error.message).toContain("extra");
    const badStepRecord = await readStepRecord(rootDir, bad.steps[0].record);
    expect(badStepRecord.status).toBe("failed");
    expect((badStepRecord as { args: unknown }).args).toEqual({ a: "a" });
    // A pickle step that can't be bound into its typed step's `args` shape
    // classifies as "binding_invalid", distinct from "args_invalid" (which
    // only ever applies to a successfully-bound value that still fails its
    // own zod schema).
    expect((badStepRecord as { error: { kind: string } }).error.kind).toBe("binding_invalid");
  });

  it(":line selects only the matching scenario in a two-scenario file", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.scenario).toBe("second scenario");
    expect(record.line).toBe(6);
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
    expect((stepRecord as { result: { label: string } }).result.label).toBe("second");

    const scenariosDir = path.join(rootDir, ".nukadoko", "records", "scenarios");
    expect(await readdir(scenariosDir)).toHaveLength(1);
  });

  it("stderr announces a partial run when :line is given, naming the selected/total scenario counts, without touching stdout's record JSON", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature:6"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain("Partial run: features/lines.feature:6 selects 1 of 2 scenarios");
    expect(stderr.text()).toContain("A partial run cannot be accepted");
    expect(stderr.text()).toContain("nuka accept");

    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.scenario).toBe("second scenario");
  });

  it("stderr says nothing about a partial run when no :line is given", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");
  });

  it("an invalid :line is a setup failure: stderr + exit 1, nothing written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature:999"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("999");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });

  it("a missing feature file is a setup failure: stderr + exit 1, nothing written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/does-not-exist.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("does-not-exist.feature");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });

  it("--tag is gone: yargs reports it as an unknown argument (design decision 2026-08-02, --tag removed)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["run", "features/passing.feature", "--tag", "issue-42"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(stderr.text()).toContain("tag");
  });

  it("an unknown flag fails setup: exit 1, stderr names it, no record/step record written (yargs runs the matched handler after .fail() unless run-cli.ts guards it)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/passing.feature", "--unknown-flag", "x"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("unknown-flag");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });
});

// A project whose step definitions
// are plain .js/.mjs, not .ts -- discovery only walked .ts before this
// task, so a suite like this one was invisible to it and every scenario
// failed as "undefined step" instead of naming the real cause. Its own
// fixture (js-steps-project), not run-project above, since run-project's
// step files are relied on as .ts by other tests in this file.
describe("nuka run: .js and .mjs step files", () => {
  it("discovers and executes a .js Given step and a .mjs Then step", async () => {
    const rootDir = await copyFixtureToTempDir("js-steps-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(stripRunProgressLines(stderr.text())).toBe("");
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.status).toBe("passed");
      expect(record.steps).toHaveLength(2);
      for (const step of record.steps) {
        expect(step.status).toBe("passed");
        expect(typeof step.record).toBe("string");
      }
      expect(exitCode).toBe(0);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
