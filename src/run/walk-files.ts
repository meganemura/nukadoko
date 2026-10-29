import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PageView, RunWalk, RunWalkPause } from "../record/run-result.js";
import {
  advanceWalk,
  callTarget,
  nothingStartedMessage,
  pauseLines,
  seeWalk,
  startWalk,
  stepDecision,
  stepReport,
  type Pause,
  type PauseFailure,
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
//   <stateDir>/walk.lock/<n>        the run of walk n, created exclusively, holding its pid, then `released`
//   <stateDir>/walk.json            the run, replaced whole (written aside, then renamed)
//   <run_dir>/answers/<n>.json      nuka step, created exclusively, never rewritten
//   <run_dir>/pauses/<n>/           the run: the views, and the open pages' requests
//   <stateDir>/walks-reported/<n>   nuka step, created exclusively once it printed how walk n ended
//
// A process that holds the lock and is gone (a crash, a SIGKILL) leaves a
// walk.json that is not ended and a pid that is not alive: a reader sees
// the walk as gone, and the next `nuka run --step` takes the lock over
// (`takeLock` says how two of them cannot both take it). A pid check, not a
// lease a process renews: it needs no clock of its own, and
// `process.kill(pid, 0)` answers the same on Windows.

export type { Pause, PauseFailure, StepCall, StepRefusalCode, StepReport, WalkAnswer, WalkEnd, WalkFound, WalkRun, WalkScenario, WalkState };
export { answerCommand, failureText, restartCommand, waitCommand, walkStanding } from "./walk.js";

const LOCK_DIR = "walk.lock";
const RELEASED = "released";
const STATE_FILE = "walk.json";
const REPORTED_DIR = "walks-reported";
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
  readonly failure?: PauseFailure;
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

/** walk.json as one read found it: a walk, no file (`null`), or a file
 * this read could not use, with why. */
type WalkRead = { readonly state: WalkState | null } | { readonly unreadable: string };

// walk.json has one writer, this module, so a reader checks only the
// fields every state carries and trusts the rest. Only a missing file
// means no walk. Any other failure is a moment to read through: on
// Windows a read can meet the file while the run renames over it, and a
// walk read as none would refuse an answer at once.
function readWalkState(filePath: string): WalkRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: null };
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== "object" || parsed === null) return { unreadable: "it holds no JSON object" };
  const value = parsed as Record<string, unknown>;
  const valid =
    typeof value["state"] === "string" &&
    WALK_STATES.has(value["state"]) &&
    Number.isInteger(value["number"]) &&
    Number.isInteger(value["pid"]) &&
    typeof value["target"] === "string" &&
    typeof value["started_at"] === "string";
  return valid ? { state: parsed as WalkState } : { unreadable: "it holds no walk state" };
}

// One past every walk this project recorded, in walk.json or as a
// reported end, so a walk.json lost or unreadable cannot give a new walk
// the number of one whose end a `nuka step` call already printed.
function highestWalkRecorded(dir: string): number {
  const stored = readWalkState(path.join(dir, STATE_FILE));
  let last = "state" in stored && stored.state !== null ? stored.state.number : 0;
  for (const walk of numberedNames(path.join(dir, REPORTED_DIR))) last = Math.max(last, walk);
  return last;
}

// The whole-number names in a directory, and none when it is missing. A
// file written aside carries a suffix, so it is never one of them.
function numberedNames(dir: string): number[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** The holder of the highest lock file: a pid, `released`, or `null` for
 * a file that holds neither. */
interface LockTop {
  readonly walk: number;
  readonly holder: number | "released" | null;
}

// A lock file is linked into place whole, so a read never meets it part
// written. Only a number below the highest is ever removed, so a file gone
// between the listing and the read means a higher one exists: list again.
function lockTop(lockDir: string): LockTop | null {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const walks = numberedNames(lockDir);
    if (walks.length === 0) return null;
    const walk = Math.max(...walks);
    let text: string;
    try {
      text = readFileSync(path.join(lockDir, String(walk)), "utf8").trim();
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const pid = Number(text);
    return { walk, holder: text === RELEASED ? "released" : Number.isInteger(pid) && pid > 0 ? pid : null };
  }
  throw new Error(`${lockDir} changed on every one of 100 reads`);
}

// Creates `target` with `text` only when it does not exist. A link is
// exclusive like a create with `wx`, and the file appears with its whole
// text: a process killed between a `wx` create and its write would leave
// an empty lock that no reader could tell from one being written.
function linkWhole(target: string, text: string): boolean {
  const aside = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(aside, text);
  try {
    linkSync(aside, target);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(aside);
  }
}

function removeQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

type LockTake = { readonly taken: number } | { readonly holder: number } | { readonly raced: true };

// The lock is a directory with one file per walk that took it, named by
// the walk's number; the highest number holds it. A run takes the lock by
// creating the next number, so it never removes a file another process may
// hold: of two runs that find the same holder dead or released, only one
// creates the next number, and the other reads the winner as alive. A file
// is removed only once a higher one exists, and only by the process that
// created that higher one, or by its own creator giving way. That keeps
// the highest number in place, so a process that read an old listing and
// created a number a cleanup had removed finds a higher one when it looks
// again, and gives way. A crash at any point leaves a dead pid on top,
// which the next run takes over; no state needs a person to clear it.
function takeLock(dir: string): LockTake {
  const lockDir = path.join(dir, LOCK_DIR);
  mkdirSync(lockDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const top = lockTop(lockDir);
    // A holder that is this process is a walk it left without ending, as
    // a test in one process can: it is not a second walk.
    if (top !== null && typeof top.holder === "number" && top.holder !== process.pid && processIsAlive(top.holder)) {
      return { holder: top.holder };
    }
    const walk = Math.max(top?.walk ?? 0, highestWalkRecorded(dir)) + 1;
    const file = path.join(lockDir, String(walk));
    if (!linkWhole(file, `${process.pid}\n`)) continue;
    if (lockTop(lockDir)?.walk !== walk) {
      removeQuietly(file);
      continue;
    }
    for (const lower of numberedNames(lockDir)) if (lower < walk) removeQuietly(path.join(lockDir, String(lower)));
    return { taken: walk };
  }
  return { raced: true };
}

// The file stays, so the highest number never goes back down; it says
// `released`, which the next run takes over like a dead pid.
function releaseLock(dir: string, walk: number): void {
  const file = path.join(dir, LOCK_DIR, String(walk));
  try {
    if (Number(readFileSync(file, "utf8").trim()) !== process.pid) return;
  } catch {
    // Already gone: a later walk took over and removed it.
    return;
  }
  replaceFile(file, `${RELEASED}\n`);
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
 * Starts the run's side of a walk: takes the lock, which numbers the walk
 * one past every walk recorded, and writes it as starting. `announce`
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
  const statePath = path.join(dir, STATE_FILE);
  const lock = takeLock(dir);
  if (!("taken" in lock)) {
    return {
      refused: "walk-in-progress",
      message:
        "raced" in lock
          ? "another nuka run --step took the walk lock at the same moment, so this one did not start"
          : `another walk is in progress in this project: nuka run --step, pid ${lock.holder}`,
    };
  }
  let state = startWalk({
    number: lock.taken,
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
        ...(facts.failure === undefined ? {} : { failure: facts.failure }),
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
        releaseLock(dir, state.number);
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

// One empty file per walk whose end a `nuka step` call printed: a wait
// that names no walk reports the newest walk until then, and waits for the
// next one after. Created exclusively, so two calls that print the same end
// leave one file.
function endReported(dir: string, walk: number): boolean {
  return existsSync(path.join(dir, REPORTED_DIR, String(walk)));
}

function markEndReported(dir: string, walk: number): void {
  mkdirSync(path.join(dir, REPORTED_DIR), { recursive: true });
  try {
    writeFileSync(path.join(dir, REPORTED_DIR, String(walk)), "", { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
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
  const dir = stateDirOf(rootDir, options.stateDir);
  const statePath = path.join(dir, STATE_FILE);
  const deadline = Date.now() + options.timeoutMs;
  // Fixed by the first read that finds walk.json readable, or finds none.
  let target: number | undefined;
  for (;;) {
    const read = readWalkState(statePath);
    if ("unreadable" in read) {
      if (Date.now() >= deadline) {
        const seconds = Math.round(options.timeoutMs / 1000);
        throw new Error(`${path.posix.join(options.stateDir.split(path.sep).join("/"), STATE_FILE)} could not be read for ${seconds}s: ${read.unreadable}`);
      }
      await sleep(POLL_MS);
      continue;
    }
    const seen = seeWalk(read.state, isAlive);
    target ??= callTarget(call, seen, (walk) => endReported(dir, walk));
    const decision = stepDecision(call, target, seen, answersOf(rootDir, seen, target));
    if (decision.kind === "write-answer") {
      if (call.kind === "answer") writeAnswer(rootDir, decision.runDir, call.pause, call.answer);
      continue;
    }
    if (decision.kind === "report") {
      const { seen: reported } = decision;
      if (reported.state === "gone") markEndReported(dir, reported.last.number);
      if (reported.state === "ended") markEndReported(dir, reported.number);
      return { kind: "report", report: stepReport(reported, call), seen: reported };
    }
    if (decision.kind === "refuse") {
      return { kind: "refuse", code: decision.code, message: decision.message, ...(decision.do === undefined ? {} : { do: decision.do }) };
    }
    if (Date.now() >= deadline) {
      // The walk the call is about, still on its way to a pause.
      if (seen.state !== "none" && seen.state !== "gone" && seen.number >= target) return { kind: "report", report: stepReport(seen, call), seen };
      return {
        kind: "refuse",
        code: "walk-not-found",
        // Only a wait gets here: an answer is decided from the first read.
        message: nothingStartedMessage(call.kind === "wait" ? call : { kind: "wait" }, Math.round(options.timeoutMs / 1000), seen),
        fields: { walk: "none", last: seen.state === "none" ? null : seen.state === "gone" ? seen.last : seen },
      };
    }
    await sleep(POLL_MS);
  }
}
