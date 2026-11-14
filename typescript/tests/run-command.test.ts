import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createObservedCollector } from "../src/context/observed.js";
import { runCommand } from "../src/index.js";
import { signalCommandGroups, withProcessRecording } from "../src/context/run-command.js";
import { parseProcStat } from "../src/process-group/process-group.js";
import { copyFixtureToTempDir, createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot, sourceNodeArgs, stepRecordDir } from "./helpers/fixtures.js";

// Responsibility: `runCommand`'s own result (exit code, output, stdin,
// environment, the two cases it rejects) and the `observed.processes` it
// adds to a step record: one entry per call in call order, recorded for a
// typed step, a part, and a compat step, redacted, and absent when no
// process ran; and what each process printed, kept as redacted files beside
// the step record. Inside a step on POSIX, each process runs in a process
// group of its own: its entry says whether the group still ran when it
// closed, a timeout stops the whole group, and a signal passed on reaches
// every process of it.

const node = process.execPath;
// The script the secret-argument fixture step runs.
const PRINT_ARGUMENT = "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1])";
// What a process run inside a step records of its group: nothing on
// Windows, which has no such group.
const grouped = process.platform === "win32" ? {} : { group: "ended" };

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

  it("writes a value named in redact as its token in the recorded command, and passes the real value", async () => {
    const observed = createObservedCollector();
    const result = await withProcessRecording(observed, () =>
      runCommand(node, ["-e", "process.stdout.write(process.argv[1])", "receipt=abc.def.ghi"], {
        redact: { RECEIPT: "abc.def.ghi" },
      }),
    );
    expect(result.stdout).toBe("receipt=abc.def.ghi");
    expect(observed.snapshot().processes?.[0]?.command).toEqual([
      node,
      "-e",
      "process.stdout.write(process.argv[1])",
      "receipt={{secret.RECEIPT}}",
    ]);
  });

  it("records every name in env, and hides each value that is not a path that exists, an integer, or a boolean", async () => {
    const observed = createObservedCollector();
    const { PATH: _path, ...rest } = process.env;
    const added = {
      NUKADOKO_TEST_DIR: process.cwd(),
      NUKADOKO_TEST_KEY: "/q8Zx+Lr0aW==",
      NUKADOKO_TEST_PORT: "8080",
      NUKADOKO_TEST_CI: "true",
      NUKADOKO_TEST_TOKEN: "ghp_0123456789abcdef",
    };
    const result = await withProcessRecording(observed, () =>
      runCommand(node, ["-e", "process.stdout.write(process.env.NUKADOKO_TEST_TOKEN)"], { env: { ...rest, ...added } }),
    );
    expect(result.stdout).toBe("ghp_0123456789abcdef");
    expect(observed.snapshot().processes?.[0]?.env).toEqual({
      added: {
        NUKADOKO_TEST_CI: "true",
        NUKADOKO_TEST_DIR: process.cwd(),
        NUKADOKO_TEST_KEY: { hidden_bytes: 13 },
        NUKADOKO_TEST_PORT: "8080",
        NUKADOKO_TEST_TOKEN: { hidden_bytes: 20 },
      },
      changed: {},
      removed: process.env.PATH === undefined ? [] : ["PATH"],
    });
  });

  it("writes a value named in redact as its token in what the process printed", async () => {
    const dir = await createEmptyTempDir();
    try {
      const observed = createObservedCollector({ outputDir: () => dir });
      await withProcessRecording(observed, () =>
        runCommand(node, ["-e", "process.stdout.write(process.argv[1])", "receipt=abc.def.ghi"], { redact: { RECEIPT: "abc.def.ghi" } }),
      );
      expect(readFileSync(path.join(dir, "process-1.stdout.txt"), "utf8")).toBe("receipt={{secret.RECEIPT}}");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("leaves no value named in redact in the recorded command", () =>
    hegel.testAsync(
      async (tc) => {
        const secret = tc.draw(gs.text({ alphabet: "abcxyz0123-._", minSize: 4, maxSize: 12 }));
        const before = tc.draw(gs.text({ alphabet: "ab=-", maxSize: 4 }));
        const observed = createObservedCollector();
        await withProcessRecording(observed, () =>
          runCommand(node, ["-e", "", "--", `${before}${secret}`, secret], { redact: { TOKEN: secret } }),
        );
        const recorded = observed.snapshot().processes?.[0]?.command ?? [];
        expect(recorded.slice(4).join(" ").replaceAll("{{secret.TOKEN}}", "")).not.toContain(secret);
        expect(recorded[5]).toBe("{{secret.TOKEN}}");
      },
      { testCases: 15 },
    ));

  it("records nothing outside a step", async () => {
    const observed = createObservedCollector();
    await runCommand(node, ["-e", ""]);
    expect(observed.snapshot()).toEqual({ processes: null, http: null, files: null, unmeasured: [] });
  });
});

/** A process's group and whether it still runs, from /proc on Linux. */
function procStat(pid: number): ReturnType<typeof parseProcStat> {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

function running(pid: number): boolean {
  const stat = procStat(pid);
  return stat !== undefined && stat.state !== "Z" && stat.state !== "X" && !stat.exiting;
}

// A helper that keeps running in the leader's group, with output of its own.
const LEAVE_HELPER = "const h = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); h.unref(); process.stdout.write(String(h.pid))";
// A leader that never ends, and a helper that holds its output open.
const HANG_WITH_HELPER = "const h = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); process.stdout.write(String(h.pid)); setTimeout(() => {}, 30000)";
const PRINT_GROUP = "process.stdout.write(require('fs').readFileSync('/proc/self/stat', 'utf8'))";

describe.runIf(process.platform !== "win32")("a process group of its own", () => {
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  });

  it.runIf(process.platform === "linux")("leads a group of its own inside a step, and stays in the caller's outside one", async () => {
    const ownGroup = procStat(process.pid)!.pgrp;
    const outside = parseProcStat((await runCommand(node, ["-e", PRINT_GROUP])).stdout)!;
    expect(outside.pgrp).toBe(ownGroup);
    const inside = await withProcessRecording(createObservedCollector(), () => runCommand(node, ["-e", PRINT_GROUP]));
    const pid = Number(inside.stdout.split(" ")[0]);
    expect(parseProcStat(inside.stdout)!.pgrp).toBe(pid);
  });

  it("records group ended when nothing it started still runs", async () => {
    const observed = createObservedCollector();
    await withProcessRecording(observed, () => runCommand(node, ["-e", "require('child_process').spawnSync(process.execPath, ['-e', ''])"]));
    expect(observed.snapshot().processes?.[0]?.group).toBe("ended");
  });

  it("records group running when a process it started still runs in its group", async () => {
    const observed = createObservedCollector();
    const result = await withProcessRecording(observed, () => runCommand(node, ["-e", LEAVE_HELPER]));
    started.push(Number(result.stdout));
    expect(observed.snapshot().processes?.[0]?.group).toBe("running");
  });

  it("stops every process of the group at the timeout, a helper that holds the output open included", async () => {
    const dir = await createEmptyTempDir();
    try {
      const observed = createObservedCollector({ outputDir: () => dir });
      await expect(withProcessRecording(observed, () => runCommand(node, ["-e", HANG_WITH_HELPER], { timeout: 500 }))).rejects.toThrow(
        `runCommand: ${node} did not exit within 500 ms and was stopped with SIGTERM`,
      );
      const helper = Number(readFileSync(path.join(dir, "process-1.stdout.txt"), "utf8"));
      started.push(helper);
      expect(running(helper)).toBe(false);
      expect(observed.snapshot().processes?.[0]).toMatchObject({ signal: "SIGTERM", timed_out: true, group: "ended" });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("passes a signal on to every process of a group whose leader still runs", async () => {
    const dir = await createEmptyTempDir();
    try {
      const ready = path.join(dir, "ready");
      const trap = (who: string) => `process.on('SIGINT', () => { process.stdout.write('${who} SIGINT;'); process.exit(0); });`;
      const helper = `${trap("helper")} require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, 30000)`;
      const leader = `${trap("leader")} require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'inherit' }); setTimeout(() => {}, 30000)`;
      const observed = createObservedCollector();
      const done = withProcessRecording(observed, () => runCommand(node, ["-e", leader], { timeout: 20_000 }));
      while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
      signalCommandGroups("SIGINT");
      const result = await done;
      expect(result.stdout.split(";").filter((part) => part !== "").sort()).toEqual(["helper SIGINT", "leader SIGINT"]);
      expect(observed.snapshot().processes?.[0]?.group).toBe("ended");
    } finally {
      await removeTempDir(dir);
    }
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
  const recordPath = path.join(stepRecordDir(rootDir, recordId), "record.json");
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
    // The files under the working directory are measured, but this test
    // runs in the repository root, where other tests write at the same time.
    expect(processes.map(({ duration_ms: _ms, files: _files, ...rest }) => rest)).toEqual([
      { command: [node, "-e", "process.exit(3)"], cwd: process.cwd(), exit_code: 3, ...grouped, env: { inherited: true } },
      { command: [node, "-e", "process.stdout.write('hello')"], cwd: process.cwd(), exit_code: 0, ...grouped, stdout: "process-2.stdout.txt", env: { inherited: true } },
    ]);
    // The first process printed nothing, so it names no file.
    expect(await readFile(path.join(rootDir, stepRecord.evidence.dir, "process-2.stdout.txt"), "utf8")).toBe("hello");
    expect(typeof processes[0]!.duration_ms).toBe("number");
    expect(processes[0]!.files).toHaveProperty("added");
    // The fixture's own state directory is where this run writes, so it is
    // skipped rather than read as the program's write.
    const skipped = (processes[0]!.files as { skipped: string[] }).skipped;
    expect(skipped).toContain(`${path.relative(process.cwd(), path.join(rootDir, ".nukadoko")).split(path.sep).join("/")}/`);
  });

  it("nuka run: a loaded secret in an argument is redacted, in the command and in what the process printed", async () => {
    const stepRecord = await stepRecordOf(6);
    const entry = stepRecord.observed.processes[0];
    expect(entry.command).toEqual([node, "-e", PRINT_ARGUMENT, "{{secret.CLI_TOKEN}}"]);
    expect(entry).toMatchObject({ stdout: "process-1.stdout.txt", stderr: "process-1.stderr.txt" });
    for (const file of ["process-1.stdout.txt", "process-1.stderr.txt"]) {
      expect(await readFile(path.join(rootDir, stepRecord.evidence.dir, file), "utf8")).toBe("{{secret.CLI_TOKEN}}");
    }
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

  it("nuka run: a step that runs nothing has null processes, no requests, no files, and no unmeasured action", async () => {
    const stepRecord = await stepRecordOf(15);
    expect(stepRecord.observed).toEqual({ processes: null, http: null, files: null, unmeasured: [] });
  });

  it("nuka do: the step record carries the processes too", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "two-commands", "--args", "{}"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text());
    expect(record.observed.processes.map((entry: { exit_code: number }) => entry.exit_code)).toEqual([3, 0]);
    expect(await readFile(path.join(rootDir, record.evidence.dir, record.observed.processes[1].stdout), "utf8")).toBe("hello");
  });
});

// A signal to the process that runs the steps cannot be sent to this
// vitest process, so `src/cli.ts` runs as a child under nukadoko's own
// loader. The signal goes to its pid alone, as `kill` sends it, so only
// the handler passing it on reaches the command. No wait here has a
// deadline of its own: the test's timeout bounds a hang.
describe.runIf(process.platform !== "win32")("a signal to nukadoko while a step runs a command", () => {
  let rootDir: string;
  let dir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-command-project");
    dir = await createEmptyTempDir();
  });

  afterEach(async () => {
    const pids = existsSync(path.join(dir, "pids")) ? readFileSync(path.join(dir, "pids"), "utf8").split("\n").filter((line) => line !== "") : [];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    await removeTempDir(rootDir);
    await removeTempDir(dir);
  });

  it(
    "reaches the command and the helper in its process group",
    async () => {
      await writeFile(path.join(rootDir, "features", "run-command.feature"), ["Feature: f", "", "  Scenario: s", "    Given a step runs a command until a signal stops it", ""].join("\n"));
      const nuka = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run"], {
        cwd: rootDir,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, SIGNAL_DIR: dir },
      });
      let stderr = "";
      nuka.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const closed = new Promise<number | null>((resolve) => nuka.once("close", (code) => resolve(code)));
      let exited = false;
      void closed.then(() => (exited = true));
      while (!existsSync(path.join(dir, "ready"))) {
        expect(exited, stderr).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      process.kill(nuka.pid!, "SIGTERM");
      expect(await closed).toBe(143);
      // nukadoko exits once it has sent the signal and torn down its
      // fixtures, without waiting for the group to handle it, so under
      // load a handler's line can land after the close.
      const signals = (): string[] =>
        existsSync(path.join(dir, "signals.txt")) ? readFileSync(path.join(dir, "signals.txt"), "utf8").split("\n").filter((line) => line !== "").sort() : [];
      const deadline = Date.now() + 10_000;
      while (signals().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(signals()).toEqual(["helper SIGTERM", "leader SIGTERM"]);
    },
    120_000,
  );
});
