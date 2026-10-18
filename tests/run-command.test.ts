import { readFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createObservedCollector } from "../src/context/observed.js";
import { runCommand } from "../src/index.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `runCommand`'s own result (exit code, output, stdin,
// environment, the two cases it rejects) and the `observed.processes` it
// adds to a step record: one entry per call in call order, recorded for a
// typed step, a part, and a compat step, redacted, and absent when no
// process ran.

const node = process.execPath;

describe("runCommand result", () => {
  it("resolves a nonzero exit with its code and both streams", async () => {
    const result = await runCommand(node, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
    ]);
    expect(result).toEqual({ exitCode: 7, signal: null, stdout: "out", stderr: "err" });
  });

  it("writes input to stdin and closes it", async () => {
    const result = await runCommand(
      node,
      ["-e", "let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => process.stdout.write(s.toUpperCase()))"],
      { input: "abc" },
    );
    expect(result.stdout).toBe("ABC");
  });

  it("closes stdin at once when no input is given", async () => {
    const result = await runCommand(node, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))"]);
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: "eof", stderr: "" });
  });

  it("uses env as the whole environment and cwd as the working directory", async () => {
    const cwd = path.dirname(node);
    const result = await runCommand(
      node,
      ["-e", "process.stdout.write(JSON.stringify([process.env.ONLY, process.env.PATH ?? null, process.cwd()]))"],
      { cwd, env: { ONLY: "this" } },
    );
    expect(JSON.parse(result.stdout)).toEqual(["this", null, cwd]);
  });

  it("decodes a multi-byte character that arrives in two writes", async () => {
    const result = await runCommand(node, [
      "-e",
      "const b = Buffer.from('é'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)",
    ]);
    expect(result.stdout).toBe("é");
  });

  it("rejects when the program cannot be started", async () => {
    await expect(runCommand("nukadoko-no-such-program-xyz")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and records the stopped process when timeout elapses", async () => {
    const observed = createObservedCollector();
    await expect(
      withProcessRecording(observed, () => runCommand(node, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 200 })),
    ).rejects.toThrow(`runCommand: ${node} did not exit within 200 ms and was stopped with SIGTERM`);
    const [entry] = observed.snapshot().processes ?? [];
    expect(entry).toMatchObject({ exit_code: null, signal: "SIGTERM", timed_out: true });
  });

  it("records nothing outside a step", async () => {
    const observed = createObservedCollector();
    await runCommand(node, ["-e", ""]);
    expect(observed.snapshot()).toEqual({ http_reads: 0, http_writes: 0 });
  });
});

describe("observed.processes", () => {
  it(
    "has one entry per call, in call order, whether the calls overlap or not",
    () =>
      hegel.testAsync(
        async (tc) => {
          const calls = tc.draw(
            gs.arrays(
              gs.tuples(gs.integers({ minValue: 0, maxValue: 255 }), gs.integers({ minValue: 0, maxValue: 60 })),
              { minSize: 0, maxSize: 4 },
            ),
          );
          const overlap = tc.draw(gs.booleans());
          const observed = createObservedCollector();
          const run = ([code, delay]: [number, number]) =>
            runCommand(node, ["-e", `setTimeout(() => process.exit(${code}), ${delay})`]);
          await withProcessRecording(observed, async () => {
            if (overlap) {
              await Promise.all(calls.map(run));
            } else {
              for (const call of calls) await run(call);
            }
          });
          const processes = observed.snapshot().processes ?? [];
          expect(processes.map((entry) => entry.exit_code)).toEqual(calls.map(([code]) => code));
          expect(processes.map((entry) => entry.command[2])).toEqual(
            calls.map(([code, delay]) => `setTimeout(() => process.exit(${code}), ${delay})`),
          );
        },
        { testCases: 15 },
      ),
    60_000,
  );
});

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, any>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("observed.processes on a step record", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-command-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function stepRecordOf(line: number): Promise<Record<string, any>> {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", `features/run-command.feature:${line}`], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    return readStepRecord(rootDir, record.steps[0].step_record_id as string);
  }

  it("nuka run: a typed step records both of its processes", async () => {
    const stepRecord = await stepRecordOf(3);
    expect(stepRecord.result).toEqual({ first: 3, second: "hello" });
    const processes = stepRecord.observed.processes as Record<string, unknown>[];
    expect(processes.map(({ duration_ms: _ms, ...rest }) => rest)).toEqual([
      { command: [node, "-e", "process.exit(3)"], cwd: process.cwd(), exit_code: 3 },
      { command: [node, "-e", "process.stdout.write('hello')"], cwd: process.cwd(), exit_code: 0 },
    ]);
    expect(typeof processes[0]!.duration_ms).toBe("number");
  });

  it("nuka run: a loaded secret in an argument is redacted", async () => {
    const stepRecord = await stepRecordOf(6);
    expect(stepRecord.observed.processes[0].command).toEqual([node, "-e", "", "{{secret.CLI_TOKEN}}"]);
  });

  it("nuka run: a part's process lands on the calling step's record", async () => {
    const stepRecord = await stepRecordOf(9);
    expect(stepRecord.observed.processes.map((entry: { exit_code: number }) => entry.exit_code)).toEqual([0]);
  });

  it("nuka run: a compat step's process is recorded", async () => {
    const stepRecord = await stepRecordOf(12);
    expect(stepRecord.observed.processes.map((entry: { command: string[] }) => entry.command)).toEqual([
      [node, "-e", "process.exit(0)"],
    ]);
  });

  it("nuka run: a step that runs nothing has no processes field", async () => {
    const stepRecord = await stepRecordOf(15);
    expect(stepRecord.observed).toEqual({ http_reads: 0, http_writes: 0 });
  });

  it("nuka do: the step record carries the processes too", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "two-commands", "--args", "{}"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text());
    expect(record.observed.processes.map((entry: { exit_code: number }) => entry.exit_code)).toEqual([3, 0]);
  });
});
