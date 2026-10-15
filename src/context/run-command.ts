import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ProcessEntry } from "../record/types.js";

// Responsibility: `runCommand`, the exported helper a step uses to run a
// command-line program under test, and the scope that lets it add what it
// ran to the step record's `observed.processes` (docs/spec.md "Records").
// It does not decide a verdict: a nonzero exit is a result the step reads,
// never a failure this module raises.
//
// It is an import, not a member of `ctx`: running a process needs nothing
// the executor injects. The executor only opens a scope around a step's
// own `run` (`withProcessRecording`), and a call inside that async chain
// records into it. A call outside any step (a script, a fixture's setup)
// runs the same way and records nothing.
//
// The scope lives on `globalThis` under a registered symbol, not in a
// module variable. A step file can reach a second copy of this module (a
// nested install, or the sources beside a built copy), and a module
// variable would then give the executor one scope and the step another, so
// every call would silently record nothing.
//
// Output is decoded once, after the process closes, from the concatenated
// bytes. Decoding each chunk on its own breaks a multi-byte character that
// a chunk boundary cuts through.

/** Receives one finished process. The shape stays this small because two
 * copies of this module, from two versions, can share one scope. */
export interface ProcessRecorder {
  startProcess(): (entry: ProcessEntry) => void;
}

const SCOPE_KEY = Symbol.for("nukadoko.runCommand.scope");

function scope(): AsyncLocalStorage<ProcessRecorder> {
  const holder = globalThis as { [SCOPE_KEY]?: AsyncLocalStorage<ProcessRecorder> };
  holder[SCOPE_KEY] ??= new AsyncLocalStorage<ProcessRecorder>();
  return holder[SCOPE_KEY];
}

/** Executor-only: runs `fn` (a step's own `run`) so that every
 * `runCommand` in its async chain records into `recorder`. */
export function withProcessRecording<T>(recorder: ProcessRecorder, fn: () => T): T {
  return scope().run(recorder, fn);
}

export interface RunCommandOptions {
  /** The working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The child's whole environment, as for Node's own `spawn`: it replaces
   * `process.env`, it is not merged into it. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Text written to the child's stdin before stdin is closed. Without it,
   * stdin is closed at once, so a program that reads stdin sees its end
   * instead of waiting forever. */
  input?: string;
  /** Milliseconds before the child is stopped with SIGTERM. `runCommand`
   * then throws, because a program that never finished has no exit code
   * for a step to assert on. */
  timeout?: number;
}

export interface RunCommandResult {
  /** The exit code, or `null` when a signal ended the process. */
  exitCode: number | null;
  /** The signal that ended the process, or `null`. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `command` with `args` and resolves with its exit code and its output
 * as UTF-8 text. A nonzero exit resolves like any other: the step decides
 * what an exit code means. It rejects only when the program could not be
 * started (for example, it does not exist) or when `timeout` stopped it.
 *
 * Inside a step's `run` (and inside a part it calls), each call adds
 * `{ command, cwd, exit_code, duration_ms }` to that step record's
 * `observed.processes`, in call order. The record is redacted like the rest
 * of the step record, so a loaded secret in an argument does not reach it.
 */
export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  // Taken at call time, so the position in `observed.processes` is the
  // call order even when calls overlap.
  const finish = scope().getStore()?.startProcess();
  const startedAt = performance.now();

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // A child that exits without reading its stdin makes the write fail
    // with EPIPE. The exit code already says what happened; an unhandled
    // stream error would instead end the whole run.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);

    child.on("error", (error) => {
      // Node emits "error" for a program that could not be started. No
      // process ran, so nothing is recorded; the step fails with this
      // error instead.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startedAt);
      finish?.({
        command: [command, ...args],
        cwd,
        exit_code: code,
        ...(signal !== null ? { signal } : {}),
        ...(timedOut ? { timed_out: true as const } : {}),
        duration_ms: durationMs,
      });
      if (timedOut) {
        rejectPromise(
          new Error(
            `runCommand: ${command} did not exit within ${options.timeout} ms and was stopped with SIGTERM`,
          ),
        );
        return;
      }
      resolvePromise({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
