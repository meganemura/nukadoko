import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { copyExamplesToTempDir, httpLogLines, removeTempDir, repoRoot, stepRecordDir, stripRunProgressLines } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: anti-rot proof for examples/migration/README.md -- the
// shipped, deliberately
// mid-migration suite (a mix of compat steps and one promoted producer/
// consumer pair) actually runs green end to end, and the record/step record
// shapes the walkthrough quotes as real captured output stay true. Only
// that mechanical claim is asserted here; the walkthrough's own stage-by-
// stage narrative is prose a reader enacts by hand, not something this
// suite re-derives (same split as tests/examples-todo.test.ts).
//
// Run against the *built* `dist/cli.js` (via `node`, not `src/cli.ts`/
// `runCli` from src), for the same reason tests/compat-discover.test.ts's
// own "resolves nukadoko/compat via the real published package" test does:
// this temp copy is nested inside this very package's own directory tree,
// so Node's self-referencing package resolution sends this example's own
// bare `"nukadoko"`/`"nukadoko/compat"` imports straight to `./dist/...`,
// unconditionally, before any node_modules shim is even consulted. Compat's
// registration buffers (Given/When/Then/Before/defineWorld) are ordinary
// module-closure state, not a Symbol.for brand -- they do not survive a
// src/dist split the way a typed `defineStep` step does, so discovery must
// run from dist too, or this suite's compat steps and its one Before hook
// would silently vanish from the vocabulary discovery itself builds.
async function runNuka(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.join(repoRoot, "dist", "cli.js");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? "", stderr: execError.stderr ?? "", exitCode: execError.code ?? 1 };
  }
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(stepRecordDir(rootDir, recordId), "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("examples/migration", () => {
  let examplesDir: string;
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(examplesDir);
  });

  it("runs the shipped mixed compat/typed suite green, with the shapes README.md quotes", async () => {
    // The program file serves ../todo/app/server.ts, so examples/todo is
    // copied beside it.
    examplesDir = await copyExamplesToTempDir(["migration", "todo"]);
    rootDir = path.join(examplesDir, "migration");

    const { stdout, stderr, exitCode } = await runNuka(["run", "--records", "features/migration.feature"], rootDir);

    expect(stripRunProgressLines(stderr)).toBe("");
    expect(exitCode).toBe(0);

    const records = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe("passed");
      for (const step of record.steps) {
        expect(step.status).toBe("passed");
      }
      // The one Before hook this suite keeps (features/steps/hooks.ts) ran
      // for every pickle, and reported ok -- no step record of its own, per
      // docs/spec.md "Compat steps"/"Running".
      expect(record.hooks).toEqual([{ type: "before", status: "passed" }]);
    }

    // Scenario 1 (still-compat glue): the stash write, the table+hashes
    // seeding step, and the RegExp count assertion.
    const scenario1 = records[0];
    const stashWriteStep = scenario1.steps.find((s: { text: string }) => s.text.includes("is stashed"));
    const seedStep = scenario1.steps.find((s: { text: string }) =>
      s.text.startsWith("the following legacy todos"),
    );
    const countStep = scenario1.steps.find((s: { text: string }) => s.text.includes("todo list has"));
    const stashReadStep = scenario1.steps.find((s: { text: string }) => s.text.includes("reads"));

    // The undeclared World stash: measured (world.writes/reads) even though
    // no schema validates it.
    const stashWriteStepRecord = await readStepRecord(rootDir, stashWriteStep.step_record_id);
    expect(stashWriteStepRecord.result).toBeNull();
    expect(stashWriteStepRecord.world).toEqual({ reads: [], writes: ["note"] });
    const stashReadStepRecord = await readStepRecord(rootDir, stashReadStep.step_record_id);
    expect(stashReadStepRecord.world).toEqual({ reads: ["note"], writes: [] });

    // The seeding step: both its http.jsonl (2 POSTs) and `world` (the one
    // declared key, seededCount) show up beside the same step record -- the
    // exact claim README.md's "measured for free" section quotes.
    const seedStepRecord = await readStepRecord(rootDir, seedStep.step_record_id);
    expect(seedStepRecord.result).toBeNull();
    // The todo app tags each log line with the request's traceparent, so
    // the step record holds the app's line for each of its requests.
    expect(seedStepRecord.observed).toEqual({
      processes: null,
      http: 2,
      files: null,
      unmeasured: [],
      program_log: { lines: 2, file: "program-log.txt", stamped: 2 },
    });
    expect(httpLogLines(rootDir, seedStep.step_record_id).map((line) => line.method)).toEqual(["POST", "POST"]);
    expect(seedStepRecord.world).toEqual({ reads: [], writes: ["seededCount"] });

    // The RegExp-pattern count assertion: read-only, no World touch.
    const countStepRecord = await readStepRecord(rootDir, countStep.step_record_id);
    expect(countStepRecord.observed).toEqual({
      processes: null,
      http: 1,
      files: null,
      unmeasured: [],
      program_log: { lines: 1, file: "program-log.txt", stamped: 1 },
    });
    expect(countStepRecord.world).toBeUndefined();

    // Scenario 1 binds no claim step: its Then is compat glue, which run.json
    // says judged it. Scenario 2 holds one claim.
    expect(records[0].claims).toEqual({ held: 0, broken: 0 });
    expect(records[0].judged_by).toBe("compat");
    expect(records[1].claims).toEqual({ held: 1, broken: 0 });
    expect(records[1].judged_by).toBeUndefined();

    // Scenario 2 (the promoted pair): the producer's validated result is
    // what the consumer, a claim step, reads through from.
    const scenario2 = records[1];
    const createStep = scenario2.steps[0];
    const consumerStep = scenario2.steps[1];
    expect(createStep.text).toContain("is created");
    expect(consumerStep.text).toBe('the created todo is titled "Read a book"');

    const createStepRecord = await readStepRecord(rootDir, createStep.step_record_id);
    expect(createStepRecord.result).toMatchObject({ title: "Read a book", done: false });
    expect(createStepRecord.observed).toEqual({
      processes: null,
      http: 1,
      files: null,
      unmeasured: [],
      program_log: { lines: 1, file: "program-log.txt", stamped: 1 },
    });
    expect(createStepRecord.world).toBeUndefined();

    const consumerStepRecord = await readStepRecord(rootDir, consumerStep.step_record_id);
    expect(consumerStepRecord.used).toEqual([
      { step_record_id: createStep.step_record_id, step: createStepRecord.step },
    ]);
    expect(consumerStepRecord.claims).toEqual([
      {
        actual: "Read a book",
        actual_from: `from:create-todo@${createStep.line}.title`,
        compare: "equal",
        expected: "Read a book",
        expected_from: "sentence:title",
        expected_text: "\"Read a book\"",
        outcome: "held",
        measured: null,
      },
    ]);
    expect(consumerStepRecord.observation).toBe("observed");
    expect(consumerStepRecord.attempts).toBe(1);
    expect(consumerStepRecord.observed).toEqual({
      processes: null,
      http: null,
      files: null,
      unmeasured: [],
      program_log: { lines: 0, file: null, stamped: 0 },
    });
    expect(consumerStepRecord.world).toBeUndefined();
  });
});
