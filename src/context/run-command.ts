import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvValue, ProcessEntry, ProcessEnv, ProcessFiles, ProcessOutput } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import { type EnvDifference, envDifference } from "./env-difference.js";
import { diffSnapshots, takeSnapshot } from "./file-snapshot.js";
import { windowsSpawnPlan } from "./windows-command.js";
import { MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_REASON } from "../timer/max-delay.js";

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
//
// On Windows a bare name such as `npm` resolves through PATH and PATHEXT,
// and a `.cmd` or `.bat` file runs through cmd.exe (windows-command.ts),
// so a step names a program the same way on every platform. The step record
// keeps the command as the step wrote it.
//
// `redact` is for a value the step itself holds, such as a token it
// signed or read from a response, passed as an argument. The executor
// redacts only what it loaded from env files, so such a value would
// otherwise reach the record, the run summary, and every report built
// from them. It is replaced here, before the entry leaves this module,
// because the executor never sees which values the step treats as secret.
//
// Inside a step, the working directory is snapshotted before the spawn and
// after the close (file-snapshot.ts), and the difference is the entry's
// `files`. A step that runs a command-line tool writes to disk, not over
// HTTP, so without it a `mutates: false` step that ran a writing program
// had nothing to be compared against. The same difference is returned to
// the step as `files`, so a step whose claim is "the command writes
// nothing" reads the measurement instead of walking the directory itself.
// Outside a step nothing is recorded, so nothing is walked unless the
// caller asks with `files: true` (a control CLI that drives the same
// program between steps).
//
// The output goes to the recorder beside the entry, not inside it, with the
// step's own `redact` values already replaced. The recorder keeps it as
// evidence files: a person reviewing a step needs what the program printed,
// and the step's result keeps only the part the step chose to return. A
// second argument, rather than a new entry field, keeps a recorder from an
// older copy of this module working: it ignores the argument, and the
// output never lands inline in its record. The `input` the step wrote to
// stdin goes the same way, so a reader sees what the program was given.
//
// The entry's `env` is the child's environment written as its difference
// from the runner's (env-difference.ts), with the step's `redact` values
// replaced: a reader wants the variables the step chose, not the tens the
// runner already had.
//
// The spawn runs outside the channel patches' recording (channels.ts): the
// process is measured here, so it is not also an unmeasured one.
//
// When the run has a world, the child gets `TRACEPARENT` in its
// environment, the OpenTelemetry convention for trace context carried
// through the environment: the step's trace id and a span id made for the
// process. A command-line tool that copies it into the `traceparent` of
// its requests to the world makes the program's log lines and execution
// events for those requests the step's. The step's own TRACEPARENT is
// kept, and so is none: a value the env holds that is the runner's own
// `process.env.TRACEPARENT` (a CI runner that is itself traced, or a
// step that spreads `process.env` into `env`) is inherited, not the
// step's choice, and is replaced. The entry's `env` is the step's choice,
// so the value nukadoko set is its `traceparent`.

/** Receives one finished process. The shape stays this small because two
 * copies of this module, from two versions, can share one scope. */
export interface ProcessRecorder {
  startProcess(): (entry: ProcessEntry, output?: ProcessOutput) => void;
  /** The `TRACEPARENT` for a process started now, kept by the boundary
   * as one of its processes' spans, or `undefined` when the run has no
   * world. Optional, so an older copy's recorder still fits. */
  processTraceparent?(): string | undefined;
  /** Absolute directories the executor writes to while a step runs, left
   * out of the file snapshot. Optional, so an older copy's recorder still
   * fits. */
  readonly unwatchedDirs?: readonly string[];
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
   * for a step to assert on. At most 2147483647 (src/timer/max-delay.ts):
   * a larger one is refused before the program starts. */
  timeout?: number;
  /** Secrets the step holds, by name. Each value is written as
   * `{{secret.NAME}}` in the recorded `command`, with the same rules as a
   * loaded secret (a value shorter than 4 characters is left as it is).
   * The program still receives the real value. */
  redact?: Readonly<Record<string, string>>;
  /** Measures the files under `cwd` outside a step too, and returns them
   * as the result's `files`. Inside a step they are always measured. */
  files?: boolean;
}

export interface RunCommandResult {
  /** The exit code, or `null` when a signal ended the process. */
  exitCode: number | null;
  /** The signal that ended the process, or `null`. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** What changed under `cwd` while the program ran, the same value as
   * the step record's `observed.processes[].files`. Present inside a step,
   * or with the `files` option; absent otherwise. */
  files?: ProcessFiles;
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
 * of the step record, so a loaded secret in an argument does not reach it;
 * a secret the step holds itself is named in `redact`.
 */
export async function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  // Before anything starts or is recorded: a timer would fire after 1 ms
  // and stop the program for a limit it was never given.
  if (options.timeout !== undefined && options.timeout > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`runCommand: timeout is ${options.timeout} ms; it must be ${MAX_TIMER_DELAY_REASON}`);
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  // Taken at call time, so the position in `observed.processes` is the
  // call order even when calls overlap.
  const recorder = scope().getStore();
  const finish = recorder?.startProcess();
  const unwatched = recorder?.unwatchedDirs ?? [];
  const before = finish === undefined && options.files !== true ? undefined : takeSnapshot(cwd, unwatched);
  const startedAt = performance.now();

  const chosen = options.env ?? process.env;
  const traceparent = chosen.TRACEPARENT === undefined || chosen.TRACEPARENT === process.env.TRACEPARENT ? recorder?.processTraceparent?.() : undefined;
  const env = traceparent === undefined ? chosen : { ...chosen, TRACEPARENT: traceparent };
  const plan =
    process.platform === "win32"
      ? windowsSpawnPlan(command, args, env)
      : { file: command, args: [...args], verbatim: false };

  return new Promise((resolvePromise, rejectPromise) => {
    const child = withoutChannelRecording(() =>
      spawn(plan.file, plan.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: plan.verbatim,
      }),
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // Stopping cmd.exe alone would leave the program it started
            // running, so the whole tree is ended.
            if (plan.verbatim && child.pid !== undefined) {
              withoutChannelRecording(() => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" })).on(
                "error",
                () => child.kill(),
              );
            } else {
              child.kill("SIGTERM");
            }
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
      const secrets = Object.entries(options.redact ?? {}).map(([name, value]) => ({ name, value }));
      const files = before === undefined ? undefined : diffSnapshots(before, takeSnapshot(cwd, unwatched));
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      finish?.({
        command: [command, ...args].map((part) => redactString(part, secrets)),
        cwd,
        exit_code: code,
        ...(signal !== null ? { signal } : {}),
        ...(timedOut ? { timed_out: true as const } : {}),
        duration_ms: durationMs,
        ...(files === undefined ? {} : { files }),
        env: recordedEnv(envDifference(process.env, options.env), secrets),
        ...(traceparent === undefined ? {} : { traceparent }),
      }, {
        stdout: redactString(out, secrets),
        stderr: redactString(err, secrets),
        ...(options.input !== undefined && options.input !== "" ? { stdin: redactString(options.input, secrets) } : {}),
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
        stdout: out,
        stderr: err,
        ...(files === undefined ? {} : { files }),
      });
    });
  });
}

// A value nukadoko can tell is not a credential: an absolute path (POSIX,
// or a Windows drive path) that exists when the process ends, a decimal
// integer, or a boolean. Redacting only
// the loaded secrets is not enough here, because a step that holds a token
// itself passes it through `env`, and the record must not become the place
// it leaks to. A reader still needs paths and numbers to judge a step, so
// those stay; the rest is its byte length, which tells set from empty. A
// path with a control character in it is hidden too: a line break can carry
// a second value that no reader would take for part of the path. The shape
// of a path is not enough on its own, because base64 can start with `/`, so
// a token can look like a path; a file that exists is measured, and a token
// names no file. A path the program was told to create and did not is
// hidden, which costs the reader that one value.
const PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/])[^\u0000-\u001f\u007f]*$/;
const PLAIN_VALUE = /^(?:-?[0-9]+|true|false)$/;

/** The value `runCommand` records for one environment variable. */
function recordedEnvValue(value: string, secrets: SecretSet, exists: (path: string) => boolean): EnvValue {
  const shown = PLAIN_VALUE.test(value) || (PATH_SHAPE.test(value) && exists(value));
  return shown ? redactString(value, secrets) : { hidden_bytes: Buffer.byteLength(value, "utf8") };
}

/** The record's `env`: every name, and each value as `recordedEnvValue`
 * gives it. `exists` is the file system's answer, replaced in tests. */
export function recordedEnv(
  env: EnvDifference,
  secrets: SecretSet,
  exists: (path: string) => boolean = existsSync,
): ProcessEnv {
  if ("inherited" in env) return env;
  const each = (values: Readonly<Record<string, string>>): Record<string, EnvValue> =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, recordedEnvValue(value, secrets, exists)]));
  return { added: each(env.added), changed: each(env.changed), removed: env.removed };
}
