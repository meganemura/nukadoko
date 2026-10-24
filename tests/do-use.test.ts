import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stepRecordDir } from "./helpers/fixtures.js";

// Responsibility: `nuka do --use <record-id>` end to end against
// tests/fixtures/do-use-project — filling a step's own `from`
// keys from an earlier execution's step record instead of the chain a scenario
// would have provided (docs/spec.md "Single steps (the agent path)", the
// `--use` paragraph). `from`'s own scenario-path injection mechanism is
// already covered by tests/from-chain.test.ts; this file only covers what's
// new here: reading a record id off the command line,
// matching it against the step actually being run's own `from`, and the
// same `used` collector recording what was actually drawn on.

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(stepRecordDir(rootDir, recordId), "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka do --use", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("do-use-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reads a step record that still says status ok, as nukadoko 0.16.1 wrote it", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const { step_record_id: recordId } = JSON.parse(createStdout.text());
    const recordPath = path.join(stepRecordDir(rootDir, recordId), "record.json");
    const stored = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, `${JSON.stringify({ ...stored, status: "ok" }, null, 2)}\n`);

    const archiveStdout = createCaptureSink();
    const archiveExit = await runCli(["do", "archive-project", "--args", "{}", "--use", recordId], {
      rootDir,
      stdout: archiveStdout,
      stderr: createCaptureSink(),
    });

    expect(archiveExit).toBe(0);
    expect(JSON.parse(archiveStdout.text()).args).toEqual({ projectId: "p_acme" });
  });

  it("fills a required from key from an earlier step record and records it in used", async () => {
    const createStdout = createCaptureSink();
    const createExit = await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    expect(createExit).toBe(0);
    const createStepRecord = JSON.parse(createStdout.text());
    expect(createStepRecord.status).toBe("passed");

    const archiveStdout = createCaptureSink();
    const archiveExit = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", createStepRecord.step_record_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(archiveExit).toBe(0);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.status).toBe("passed");
    // The value `--use` drew lands on the step record's own `args`, same as a
    // scenario-path `from` injection does (tests/from-chain.test.ts) — a
    // reader must be able to tell it apart from a value never validated.
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme" });
    expect(archiveStepRecord.result).toEqual({ archived: true, projectId: "p_acme" });
    // Where each key came from: the producer's from the command line, the
    // consumer's from the step record `--use` named.
    expect(createStepRecord.args_origin).toEqual({ name: "command_line" });
    expect(archiveStepRecord.args_origin).toEqual({
      projectId: { from: { step_record_id: createStepRecord.step_record_id, step: "create-project", key: "id" } },
    });
    expect(archiveStepRecord.used).toEqual([
      { step_record_id: createStepRecord.step_record_id, step: "create-project" },
    ]);

    // Confirms the step record actually persisted to disk carries the same shape
    // the stdout copy did.
    const persisted = await readStepRecord(rootDir, archiveStepRecord.step_record_id);
    expect(persisted.used).toEqual(archiveStepRecord.used);
  });

  it("--use twice: two different upstream keys both fill, both land in used in call order", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerStepRecord = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "archive-project-with-owner",
        "--args",
        "{}",
        "--use",
        createStepRecord.step_record_id,
        "--use",
        ownerStepRecord.step_record_id,
      ],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.status).toBe("passed");
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme", ownerId: "o_jane" });
    expect(archiveStepRecord.result).toEqual({ archived: true, projectId: "p_acme", ownerId: "o_jane" });
    expect(archiveStepRecord.used).toEqual([
      { step_record_id: createStepRecord.step_record_id, step: "create-project" },
      { step_record_id: ownerStepRecord.step_record_id, step: "create-owner" },
    ]);
  });

  it("a failed step's step record carries every --use'd upstream's own result", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerStepRecord = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "archive-project-with-owner-fails",
        "--args",
        "{}",
        "--use",
        createStepRecord.step_record_id,
        "--use",
        ownerStepRecord.step_record_id,
      ],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.status).toBe("failed");
    // Both upstreams, each carrying its own full result — not just the
    // first one.
    expect(archiveStepRecord.used).toEqual([
      { step_record_id: createStepRecord.step_record_id, step: "create-project", result: { id: "p_acme" } },
      { step_record_id: ownerStepRecord.step_record_id, step: "create-owner", result: { id: "o_jane" } },
    ]);
  });

  it("--args wins over --use for the same key; a fully-overridden step record is not cited in used", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", '{"projectId":"explicit-id"}', "--use", createStepRecord.step_record_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.args).toEqual({ projectId: "explicit-id" });
    expect(archiveStepRecord.result).toEqual({ archived: true, projectId: "explicit-id" });
    // Nothing was actually drawn from the step record (its one matching key was
    // already set by --args), so it is not cited (docs/spec.md "Single steps
    // (the agent path)": "the step record ids actually drawn from land in this
    // execution's own used").
    expect(archiveStepRecord.used).toBeUndefined();
  });

  it("a failed step record passed to --use fails setup: stderr, exit 2, no step record written", async () => {
    const failedStdout = createCaptureSink();
    const failedExit = await runCli(["do", "create-project", "--args", "{}"], {
      rootDir,
      stdout: failedStdout,
      stderr: createCaptureSink(),
    });
    expect(failedExit).toBe(1);
    const failedStepRecord = JSON.parse(failedStdout.text());
    expect(failedStepRecord.status).toBe("failed");

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", failedStepRecord.step_record_id],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(2);
    // Setup-phase fatal, same family as an unregistered `from` upstream: no
    // step record is ever printed to stdout.
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain(failedStepRecord.step_record_id);
    expect(archiveStderr.text()).toContain('not "passed"');
  });

  it("a step record whose step is not named by any from entry fails setup", async () => {
    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerStepRecord = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", ownerStepRecord.step_record_id],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(2);
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain(ownerStepRecord.step_record_id);
    expect(archiveStderr.text()).toContain("create-owner");
  });

  it("--args may be omitted entirely when --use fills every key", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(["do", "archive-project", "--use", createStepRecord.step_record_id], {
      rootDir,
      stdout: archiveStdout,
      stderr: archiveStderr,
    });

    expect(exitCode).toBe(0);
    expect(archiveStderr.text()).toBe("");
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.status).toBe("passed");
    // No --args at all means the default is `{}`, so every key on this
    // step record's own `args` came from `--use`'s `from` injection alone.
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme" });
    expect(archiveStepRecord.used).toEqual([
      { step_record_id: createStepRecord.step_record_id, step: "create-project" },
    ]);
  });

  it("neither --args nor --use: refused before any step record is written, naming both flags", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "archive-project"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("--args");
    expect(stderr.text()).toContain("--use");
  });

  it("an unknown record id fails setup", async () => {
    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", "step-20260101-000000-zzzz"],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(2);
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain("step-20260101-000000-zzzz");
    expect(archiveStderr.text()).toContain("no such step record");
    // The id may have been right once: the refusal says records have a
    // lifetime, with the numbers in force.
    expect(archiveStderr.text()).toContain("older than the newest 20 runs");
  });

  it("--args and --use hand a z.bigint() key the bigint its stored decimal string spells", async () => {
    const countStdout = createCaptureSink();
    const countExit = await runCli(
      ["do", "count-atoms", "--args", '{"count":"123456789012345678901234567890"}'],
      { rootDir, stdout: countStdout, stderr: createCaptureSink() },
    );
    expect(countExit).toBe(0);
    const countStepRecord = JSON.parse(countStdout.text());
    expect(countStepRecord.result).toEqual({ total: "123456789012345678901234567890" });

    const doubleStdout = createCaptureSink();
    const doubleExit = await runCli(["do", "double-atoms", "--use", countStepRecord.step_record_id], {
      rootDir,
      stdout: doubleStdout,
      stderr: createCaptureSink(),
    });
    expect(doubleExit).toBe(0);
    const doubleStepRecord = JSON.parse(doubleStdout.text());
    expect(doubleStepRecord.status).toBe("passed");
    expect(doubleStepRecord.args).toEqual({ total: "123456789012345678901234567890" });
    expect(doubleStepRecord.result).toEqual({ doubled: "246913578024691357802469135780" });
  });

  it("--args with a string that is not a decimal integer still fails a z.bigint() key", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "count-atoms", "--args", '{"count":"12x"}'], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.error.message).toBe("args validation failed: count: Invalid input: expected bigint, received string");
  });

  it("--args hands a pipe, a codec, and a transform the input side of their schema", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "shape-atoms",
        "--args",
        '{"piped":"5","coded":"6","stamped":"2024-01-01T00:00:00.000Z","doubled":"7","epoch":"2024-01-01T00:00:00.000Z"}',
      ],
      { rootDir, stdout, stderr: createCaptureSink() },
    );
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.error).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(stepRecord.result).toEqual({
      piped: "5",
      coded: "6",
      stamped: "2024-01-01T00:00:00.000Z",
      doubled: "14",
      epoch: 1704067200000,
    });
  });

  it("--use hands a pipe, a codec, and a transform the input side of their schema", async () => {
    const countStdout = createCaptureSink();
    await runCli(["do", "count-atoms", "--args", '{"count":"5"}'], {
      rootDir,
      stdout: countStdout,
      stderr: createCaptureSink(),
    });
    const countStepRecord = JSON.parse(countStdout.text());

    const shapeStdout = createCaptureSink();
    const shapeExit = await runCli(
      [
        "do",
        "shape-atoms",
        "--args",
        '{"stamped":"2024-01-01T00:00:00.000Z","epoch":"2024-01-01T00:00:00.000Z"}',
        "--use",
        countStepRecord.step_record_id,
      ],
      { rootDir, stdout: shapeStdout, stderr: createCaptureSink() },
    );
    const shapeStepRecord = JSON.parse(shapeStdout.text());
    expect(shapeStepRecord.error).toBeUndefined();
    expect(shapeExit).toBe(0);
    expect(shapeStepRecord.result).toEqual({
      piped: "5",
      coded: "5",
      stamped: "2024-01-01T00:00:00.000Z",
      doubled: "10",
      epoch: 1704067200000,
    });
  });

  it("--args leaves a string alone where a union option accepts it, whichever option is declared first", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "sort-atoms", "--args", '{"first":"5","second":"5"}'], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).result).toEqual({ first: "string", second: "string" });
  });
});
