import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PageView, RunWalk, RunWalkPause } from "../record/run-result.js";
import {
  advanceWalk,
  callTarget,
  pauseLines,
  seeWalk,
  startWalk,
  stepDecision,
  stepReport,
  type Pause,
  type StepCall,
  type StepRefusalCode,
  type StepReport,
  type WalkAnswer,
  type WalkEnd,
  type WalkEvent,
  type WalkFound,
  type WalkRun,
  type WalkScenario,
  type WalkSeen,
  type WalkState,
} from "./walk.js";

// Responsibility: the files a walk of `nuka run --step` and `nuka step`
// share, read and written from both sides. Boundary: nothing else names
// these files, and nothing here decides anything: walk.ts says what a state
// becomes and what a call does next, run-scenario.ts says when a step is
// done, and the CLI prints.
//
// Each file has one writer, so no write needs a lock of its own:
//
//   <stateDir>/walk.lock            the run, created exclusively, holding its pid
//   <stateDir>/walk.json            the run, replaced whole (written aside, then renamed)
//   <run_dir>/answers/<n>.json      nuka step, created exclusively, never rewritten
//   <run_dir>/pauses/<n>/           the run: the views, and the open pages' requests
//
// A process that holds the lock and is gone (a crash, a SIGKILL) leaves a
// walk.json that is not ended and a pid that is not alive: a reader sees
// the walk as gone, and the next `nuka run --step` takes the lock over. A
// pid check, not a lease a process renews: it needs no clock of its own,
// and `process.kill(pid, 0)` answers the same on Windows.

export type { Pause, StepCall, StepRefusalCode, StepReport, WalkAnswer, WalkEnd, WalkFound, WalkRun, WalkScenario, WalkState };
export { answerCommand, restartCommand, waitCommand } from "./walk.js";

const LOCK_FILE = "walk.lock";
const STATE_FILE = "walk.json";
const POLL_MS = 100;

/** What run-scenario.ts knows of a step once it and its AfterStep hooks
 * ran, for the pause after it. */
export interface StepPauseFacts {
  /** The step's place in the scenario, from 1: the pause number. */
  readonly step: number;
  readonly of: number;
  readonly line: number | null;
  readonly text: string;
  readonly stepName: string;
  readonly status: "passed" | "failed";
  readonly stepRecordId: string;
  /** The step record's directory, relative to the run directory. */
  readonly record: string;
  readonly error?: { readonly message: string };
  readonly remaining: number;
  /** From now until the next step, the requests the open pages send land
   * in `dir`, never in the step's own record; and each open page's view is
   * written there. run-scenario.ts holds the browser. */
  readonly holdPages: (dir: string, recordedAs: string) => Promise<readonly PageView[]>;
}

/** The run's side of one walk. */
export interface WalkHandle {
  readonly number: number;
  /** The run has its directory and its one scenario. */
  begin(run: WalkRun): void;
  /** Writes the pause and waits for its answer. */
  pauseAfter(facts: StepPauseFacts): Promise<WalkAnswer>;
  /** run.json's `walk`: each pause so far, and its answer. */
  record(): RunWalk;
  /** Records how the walk ended and releases the lock. The first call
   * wins: a signal's cleanup and the run's own end can both reach it. */
  end(end: WalkEnd): void;
}

export interface WalkRefusal {
  readonly refused: "walk-in-progress";
  readonly message: string;
}

/** Whether `pid` is a live process. `EPERM` is a process this one may not
 * signal, which is alive. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stateDirOf(rootDir: string, stateDir: string): string {
  return path.join(rootDir, stateDir);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

// A synchronous wait, for the one write that has to be synchronous: the
// end a signal records runs right before the process exits.
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows a rename onto a file another process has open for reading
// can fail for a moment. A reader holds it only for one read.
function replaceFile(filePath: string, text: string): void {
  const aside = `${filePath}.${process.pid}.tmp`;
  writeFileSync(aside, text);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(aside, filePath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      pauseSync(25);
    }
  }
}

const WALK_STATES = new Set(["starting", "running", "paused", "ended"]);

// walk.json has one writer, this module, so a reader checks only the
// fields every state carries and trusts the rest. A file that does not
// parse is one this reader cannot use, which is the same to it as none.
function readWalkState(filePath: string): WalkState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const valid =
    typeof value["state"] === "string" &&
    WALK_STATES.has(value["state"]) &&
    Number.isInteger(value["number"]) &&
    Number.isInteger(value["pid"]) &&
    typeof value["target"] === "string" &&
    typeof value["started_at"] === "string";
  return valid ? (parsed as WalkState) : null;
}

// The lock holds the pid of the process that took it. A holder that is not
// alive left it behind, and taking it over is safe; two processes that both
// find it dead race for the exclusive create, and one of them loses.
function takeLock(lockPath: string): number | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return null;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let holder: number | null = null;
    try {
      const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
      holder = Number.isInteger(pid) ? pid : null;
    } catch {
      // Gone between the create and the read: try the create again.
    }
    if (holder !== null && holder !== process.pid && processIsAlive(holder)) return holder;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return -1;
}

function releaseLock(lockPath: string): void {
  try {
    if (Number.parseInt(readFileSync(lockPath, "utf8"), 10) === process.pid) unlinkSync(lockPath);
  } catch {
    // Already gone, or taken over: either way it is not this process's.
  }
}

interface AnswerFile {
  readonly answer: WalkAnswer;
  readonly answered_at: string;
}

// An answer file is created exclusively and written in one call, so a
// reader can catch it empty for a moment: that reads as not answered yet,
// and the next poll reads it whole.
function readAnswer(filePath: string): AnswerFile | null {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const answer = value["answer"];
    if ((answer !== "next" && answer !== "stop") || typeof value["answered_at"] !== "string") return null;
    return { answer, answered_at: value["answered_at"] };
  } catch {
    return null;
  }
}

function answersDir(rootDir: string, runDir: string): string {
  return path.join(rootDir, runDir, "answers");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the run's side of a walk: takes the lock, numbers the walk one
 * past the last walk.json recorded, and writes it as starting. `announce`
 * gets the two lines of each pause, outside `--json`.
 */
export function openWalk(options: {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly target: string;
  readonly announce?: (text: string) => void;
}): WalkHandle | WalkRefusal {
  const { rootDir, announce } = options;
  const dir = stateDirOf(rootDir, options.stateDir);
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const statePath = path.join(dir, STATE_FILE);
  const holder = takeLock(lockPath);
  if (holder !== null) {
    return {
      refused: "walk-in-progress",
      message:
        holder === -1
          ? "another nuka run --step took the walk lock at the same moment, so this one did not start"
          : `another walk is in progress in this project: nuka run --step, pid ${holder}`,
    };
  }
  let state = startWalk({
    number: (readWalkState(statePath)?.number ?? 0) + 1,
    pid: process.pid,
    target: options.target,
    started_at: new Date().toISOString(),
  });
  const apply = (event: WalkEvent): void => {
    state = advanceWalk(state, event);
    replaceFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  replaceFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const pauses: Omit<RunWalkPause, "http">[] = [];
  let runDir: string | null = null;
  let ended = false;
  return {
    number: state.number,
    begin(run) {
      runDir = run.run_dir;
      apply({ kind: "begun", run });
    },
    async pauseAfter(facts) {
      if (runDir === null) throw new Error("a walk pauses only after it began");
      const k = facts.step;
      const recordedAs = `pauses/${k}`;
      const pauseDir = path.join(rootDir, runDir, "pauses", String(k));
      mkdirSync(pauseDir, { recursive: true });
      const views = await facts.holdPages(pauseDir, recordedAs);
      const pause: Pause = {
        pause: k,
        of: facts.of,
        line: facts.line,
        text: facts.text,
        step: facts.stepName,
        status: facts.status,
        record: facts.record,
        ...(facts.error === undefined ? {} : { error: facts.error }),
        remaining: facts.remaining,
        paused_at: new Date().toISOString(),
        views,
      };
      apply({ kind: "paused", pause });
      announce?.(pauseLines(state.number, pause));
      const answerPath = path.join(answersDir(rootDir, runDir), `${k}.json`);
      let answer = readAnswer(answerPath);
      while (answer === null) {
        await sleep(POLL_MS);
        answer = readAnswer(answerPath);
      }
      pauses.push({
        pause: k,
        line: facts.line,
        step_record_id: facts.stepRecordId,
        paused_at: pause.paused_at,
        answered_at: answer.answered_at,
        answer: answer.answer,
        views,
      });
      apply({ kind: "answered", pause: k, answer: answer.answer });
      return answer.answer;
    },
    record() {
      return {
        pauses: pauses.map((entry) => {
          const http = `pauses/${entry.pause}/http.jsonl`;
          return runDir !== null && existsSync(path.join(rootDir, runDir, http)) ? { ...entry, http } : entry;
        }),
      };
    },
    end(end) {
      if (ended) return;
      ended = true;
      try {
        apply({ kind: "ended", end, at: new Date().toISOString() });
      } finally {
        releaseLock(lockPath);
      }
    },
  };
}

/** What one `nuka step` call came to: a report on the walk, or a refusal
 * of its own, with what it saw. */
export type StepCallResult =
  | { readonly kind: "report"; readonly report: StepReport; readonly seen: WalkFound }
  | {
      readonly kind: "refuse";
      readonly code: StepRefusalCode;
      readonly message: string;
      readonly do?: string;
      readonly fields?: Readonly<Record<string, unknown>>;
    };

function answersOf(rootDir: string, seen: WalkSeen, target: number): Map<number, WalkAnswer> {
  const answers = new Map<number, WalkAnswer>();
  const state = seen.state === "none" ? null : seen.state === "gone" ? seen.last : seen;
  const runDir = state === null || state.state === "starting" ? undefined : state.run_dir;
  if (state === null || state.number !== target || runDir === undefined) return answers;
  const dir = answersDir(rootDir, runDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return answers;
  }
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match === null) continue;
    const answer = readAnswer(path.join(dir, name));
    if (answer !== null) answers.set(Number(match[1]), answer.answer);
  }
  return answers;
}

function writeAnswer(rootDir: string, runDir: string, pause: number, answer: WalkAnswer): void {
  const dir = answersDir(rootDir, runDir);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ answer, answered_at: new Date().toISOString() } satisfies AnswerFile)}\n`;
  try {
    writeFileSync(path.join(dir, `${pause}.json`), text, { flag: "wx" });
  } catch (error) {
    // Another call answered first. The next read of the answers decides
    // whether this call repeats it or contradicts it.
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

/**
 * One `nuka step` call: reads walk.json until the walk reaches a state the
 * call can report, writing the call's answer once when the walk waits at
 * its pause. Repeating a call is safe. `timeoutMs` bounds the wait: a walk
 * still running then is reported as running, with the call itself as its
 * `do`, and a wait that never found its walk is refused as walk-not-found.
 */
export async function runStepCall(options: {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly call: StepCall;
  readonly timeoutMs: number;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<StepCallResult> {
  const { rootDir, call } = options;
  const isAlive = options.isAlive ?? processIsAlive;
  const statePath = path.join(stateDirOf(rootDir, options.stateDir), STATE_FILE);
  const read = (): WalkSeen => seeWalk(readWalkState(statePath), isAlive);
  const target = callTarget(call, read());
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const seen = read();
    const decision = stepDecision(call, target, seen, answersOf(rootDir, seen, target));
    if (decision.kind === "write-answer") {
      if (call.kind === "answer") writeAnswer(rootDir, decision.runDir, call.pause, call.answer);
      continue;
    }
    if (decision.kind === "report") return { kind: "report", report: stepReport(decision.seen, call), seen: decision.seen };
    if (decision.kind === "refuse") {
      return { kind: "refuse", code: decision.code, message: decision.message, ...(decision.do === undefined ? {} : { do: decision.do }) };
    }
    if (Date.now() >= deadline) {
      // The walk the call is about, still on its way to a pause.
      if (seen.state !== "none" && seen.state !== "gone" && seen.number >= target) return { kind: "report", report: stepReport(seen, call), seen };
      const seconds = Math.round(options.timeoutMs / 1000);
      return {
        kind: "refuse",
        code: "walk-not-found",
        message: `no walk started within ${seconds}s: nuka step waits for the walk a nuka run --step records, and none was recorded`,
        fields: { walk: "none", last: seen.state === "none" ? seen.last : seen.state === "gone" ? seen.last : seen },
      };
    }
    await sleep(POLL_MS);
  }
}
