import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `from` end to end against
// tests/fixtures/from-project — the scenario path's injection mechanism
// (docs/spec.md "Chaining steps"), the `used` shape it feeds into
// (`{ step_record_id, step }`), `ctx.resultOf`'s unregistered-Step throw, and
// `from`'s own startup-fatal check under `nuka do`. `ctx.resultOf`'s
// "recorded as used"/"most recent wins"/"never crosses a scenario boundary"
// behavior is already covered by tests/resultof.test.ts (updated for the new
// `used` shape by this same task) — this file only covers what's new: `from`
// itself, and the two places it and `ctx.resultOf` now share a throw/used
// contract.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("from: scenario-path injection", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fills a required key from the upstream step's most recent result when the pattern doesn't capture it", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);

    const createRecordId = record.steps[0].step_record_id as string;
    const archiveStepRecord = await readStepRecord(rootDir, record.steps[1].step_record_id as string);

    expect(archiveStepRecord.status).toBe("ok");
    // The injected value lands on the step record's own `args` — the step
    // actually ran with it, so the step record should say so (a reader must
    // be able to tell an injected value apart from one that
    // was never validated at all).
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme" });
    expect(archiveStepRecord.result).toEqual({ archived: true, projectId: "p_acme" });
    // `used` cites the upstream step record in the `{ step_record_id, step }` shape.
    expect(archiveStepRecord.used).toEqual([{ step_record_id: createRecordId, step: "create-project" }]);
  });

  it("a captured value wins over from; no injection means no used entry", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:7"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const archiveStepRecord = await readStepRecord(rootDir, record.steps[1].step_record_id as string);
    expect(archiveStepRecord.args).toEqual({ projectId: "explicit-id" });
    expect(archiveStepRecord.result).toEqual({ archived: true, projectId: "explicit-id" });
    // The pattern captured `projectId` itself, so `from` never fired and
    // `used` is omitted (docs/spec.md "Records": present only when non-
    // empty).
    expect(archiveStepRecord.used).toBeUndefined();
  });

  it("the upstream hasn't run yet: the binding-order check now catches this before the step ever runs", async () => {
    // This scenario used to actually run and fail args validation; the
    // pre-execution binding-order guard now catches it before the step ever
    // runs, so args validation is no longer the last line of defense — see
    // tests/run-from-order.test.ts for that guard's own dedicated coverage
    // (missing vs. later upstream, other scenarios unaffected). This test
    // only needs to keep proving the *message* still names the key and the
    // upstream step, now from the guard instead of from args validation.
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:11"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("failed");
    // `step_record_id: null`, not a real step record id — this step's own
    // `run` never executed at all.
    expect(record.steps[0].step_record_id).toBeNull();
    const message = record.steps[0].error.message as string;
    expect(message).toContain("projectId");
    expect(message).toContain("create-project");
  });

  it("the upstream ran twice in one scenario: the most recent result is what from injects", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:14"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(3);

    const secondCreateRecordId = record.steps[1].step_record_id as string;
    const archiveStepRecord = await readStepRecord(rootDir, record.steps[2].step_record_id as string);

    expect(archiveStepRecord.args).toEqual({ projectId: "p_second" });
    expect(archiveStepRecord.used).toEqual([{ step_record_id: secondCreateRecordId, step: "create-project" }]);
  });

  it("from and ctx.resultOf reading the same upstream in one execution still dedupe in used", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:19"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const createRecordId = record.steps[0].step_record_id as string;
    const closeStepRecord = await readStepRecord(rootDir, record.steps[1].step_record_id as string);

    expect(closeStepRecord.result).toEqual({ closed: true, projectId: "p_acme", projectName: "acme" });
    // One entry, not two: `from`'s own injection and this step's own
    // `ctx.resultOf(createProject)` call both read the exact same stepRecord,
    // and both write into the same collector.
    expect(closeStepRecord.used).toEqual([{ step_record_id: createRecordId, step: "create-project" }]);
  });

  it("a failed step's step record carries the from-injected value's own result", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:33"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);

    const createRecordId = record.steps[0].step_record_id as string;
    const explodeStepRecord = await readStepRecord(rootDir, record.steps[1].step_record_id as string);

    expect(explodeStepRecord.status).toBe("failed");
    // The upstream's own full validated result, not just the `projectId` key
    // `from` happened to read.
    expect(explodeStepRecord.used).toEqual([
      { step_record_id: createRecordId, step: "create-project", result: { id: "p_acme", name: "acme" } },
    ]);
  });
});

describe("ctx.resultOf: unregistered Step throws", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka do: calling ctx.resultOf with a Step discovery never registered throws (fails the step, not a setup error)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "read-phantom-via-resultof", "--args", "{}"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.message).toContain("discovery never registered");
  });
});

describe("from: unregistered upstream is a startup fatal under nuka do", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses to execute the step at all; no step record, stderr names the problem", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project-unregistered-from", "--args", '{"projectId":"p1"}'],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    // Setup-phase fatal, same family as ConfigError/DuplicateStepError: no
    // step record is ever printed to stdout.
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("archive-project-unregistered-from");
    expect(stderr.text()).toContain("never registered");
  });
});

describe("nuka steps --json: from is exposed", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("shows from as key -> { step, key } for a step that declares it", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ name: string; from?: unknown }> };
    const archive = report.steps.find((s) => s.name === "archive-project");
    expect(archive?.from).toEqual({ projectId: { step: "create-project", key: "id" } });

    // A step with no `from` at all omits the field entirely (same "absent
    // when empty" convention as `rationale`/`used`).
    const create = report.steps.find((s) => s.name === "create-project");
    expect(create).not.toHaveProperty("from");
  });

  it("nuka describe shows from in a human-readable 'step.key' form", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "archive-project"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract.from).toEqual({ projectId: "create-project.id" });
  });
});
