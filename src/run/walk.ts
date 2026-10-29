import type { Finding } from "../finding/finding.js";
import type { PageView } from "../record/run-result.js";
import type { ScenarioStop } from "../record/scenario-record.js";

// Responsibility: a walk of `nuka run --step` as data: the states one walk
// passes through, the one transition the run applies to move it, and what
// one `nuka step` call does next and prints. Boundary: pure. No file
// system, no clock, no process; walk-files.ts reads and writes the files
// both sides share, and run-scenario.ts holds the step that pauses.
//
// One walk is one execution of one scenario. Pause k comes after step k, so
// a pause number names the step a person was shown, and an answer names
// the pause it answers: an answer to a pause nobody was shown is refused,
// never applied to whichever pause is open. Pause numbers only increase,
// and `ended` absorbs every later event, so a replayed answer or a late
// signal cannot move a walk backwards.

export type WalkAnswer = "next" | "stop";

export type { PageView };

/** What the run shows at one pause: the step it ran, its record, and the
 * pages it left open. */
export interface Pause {
  /** The step the run paused after, from 1: pause k is step k. */
  readonly pause: number;
  /** The scenario's step count. */
  readonly of: number;
  readonly line: number | null;
  readonly text: string;
  /** The step name `nuka steps` lists. */
  readonly step: string;
  readonly status: "passed" | "failed";
  /** The step record's directory, relative to the run directory. */
  readonly record: string;
  readonly error?: { readonly message: string };
  /** Steps that run on `next`: 0 after the last step, or after a step
   * that failed the scenario, since the steps after it are skipped either
   * way. A stop there skips nothing. */
  readonly remaining: number;
  readonly paused_at: string;
  readonly views: readonly PageView[];
}

export interface WalkScenario {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  readonly environment: string;
}

/** What every state of a walk knows from its start. `number` counts the
 * walks of the project, so a `nuka step wait` that finds the previous walk
 * ended waits for the next number. */
interface WalkStart {
  readonly number: number;
  readonly pid: number;
  /** The `nuka run` targets as given, for a message that names the walk. */
  readonly target: string;
  readonly started_at: string;
}

/** What a walk knows once its run has a directory and its scenario. */
export interface WalkRun {
  readonly run_id: string;
  /** Relative to the project root. */
  readonly run_dir: string;
  readonly scenario: WalkScenario;
  readonly world: { readonly url: string } | null;
}

/** How a walk ended. `finished`: run.json was written, and `findings` are
 * the run's. `not-run`: the run stopped before its scenario ran (a
 * refusal, or nothing selected), with the findings it printed.
 * `interrupted`: a signal ended the run, which writes no run.json. */
export type WalkEnd =
  | { readonly how: "finished"; readonly exit_code: number; readonly findings: readonly Finding[]; readonly stopped?: ScenarioStop }
  | { readonly how: "not-run"; readonly exit_code: number; readonly findings: readonly Finding[] }
  | { readonly how: "interrupted"; readonly exit_code: number; readonly signal: string };

export type WalkState =
  | (WalkStart & { readonly state: "starting" })
  | (WalkStart & WalkRun & { readonly state: "running"; readonly after: number })
  | (WalkStart & WalkRun & { readonly state: "paused"; readonly pause: Pause })
  | (WalkStart & Partial<WalkRun> & { readonly state: "ended"; readonly end: WalkEnd; readonly ended_at: string });

export type WalkEvent =
  | { readonly kind: "begun"; readonly run: WalkRun }
  | { readonly kind: "paused"; readonly pause: Pause }
  | { readonly kind: "answered"; readonly pause: number; readonly answer: WalkAnswer }
  | { readonly kind: "ended"; readonly end: WalkEnd; readonly at: string };

/** A transition the walk's table does not have: a bug in the run that
 * applies events, never something a reader of walk.json can cause. */
export class WalkTransitionError extends Error {}

function runOf(state: WalkStart & WalkRun): WalkRun {
  return { run_id: state.run_id, run_dir: state.run_dir, scenario: state.scenario, world: state.world };
}

function startOf(state: WalkStart): WalkStart {
  return { number: state.number, pid: state.pid, target: state.target, started_at: state.started_at };
}

/** The walk's first state, before the run knows its scenario. */
export function startWalk(start: WalkStart): WalkState {
  return { ...startOf(start), state: "starting" };
}

/**
 * One transition:
 *
 *     starting --begun--> running(after 0) --paused(k > after)--> paused(k)
 *     paused(k) --answered(k)--> running(after k)
 *     any live state --ended--> ended, which absorbs every later event
 *
 * Throws `WalkTransitionError` for any other pair.
 */
export function advanceWalk(state: WalkState, event: WalkEvent): WalkState {
  if (state.state === "ended") return state;
  if (event.kind === "ended") {
    const run = state.state === "starting" ? {} : runOf(state);
    return { ...startOf(state), ...run, state: "ended", end: event.end, ended_at: event.at };
  }
  switch (state.state) {
    case "starting":
      if (event.kind === "begun") return { ...startOf(state), ...event.run, state: "running", after: 0 };
      break;
    case "running":
      if (event.kind === "paused" && event.pause.pause > state.after) {
        return { ...startOf(state), ...runOf(state), state: "paused", pause: event.pause };
      }
      break;
    case "paused":
      if (event.kind === "answered" && event.pause === state.pause.pause) {
        return { ...startOf(state), ...runOf(state), state: "running", after: state.pause.pause };
      }
      break;
  }
  throw new WalkTransitionError(`a walk ${state.state} cannot take ${event.kind}`);
}

/** The one spelling of an answer, for the do lines and the refusals. */
export function answerCommand(pause: number, answer: WalkAnswer): string {
  return `nuka step ${answer} ${pause}`;
}

/** walk.json as `nuka step` reads it. A walk whose process is gone without
 * recording its end is `gone`: killed, or crashed. `none`: no walk was
 * ever recorded, or the walk a call is about was replaced. */
export type WalkSeen =
  | WalkState
  | { readonly state: "gone"; readonly last: WalkState }
  | { readonly state: "none"; readonly last: WalkState | null };

/** What `nuka step` sees in walk.json: a live state whose pid is not
 * alive reads as `gone`. */
export function seeWalk(stored: WalkState | null, isAlive: (pid: number) => boolean): WalkSeen {
  if (stored === null) return { state: "none", last: null };
  if (stored.state !== "ended" && !isAlive(stored.pid)) return { state: "gone", last: stored };
  return stored;
}

function numberOf(seen: WalkSeen): number | null {
  if (seen.state === "none") return null;
  if (seen.state === "gone") return seen.last.number;
  return seen.number;
}

export type StepCall = { readonly kind: "wait" } | { readonly kind: "answer"; readonly pause: number; readonly answer: WalkAnswer };

/** The walk one `nuka step` call is about, fixed when the call starts. A
 * wait that finds the previous walk over waits for the next one, which a
 * `nuka run --step` started just before it has not recorded yet. An answer
 * is about the walk that was shown. */
export function callTarget(call: StepCall, atStart: WalkSeen): number {
  const number = numberOf(atStart) ?? 0;
  if (call.kind === "answer") return number;
  return atStart.state === "none" || atStart.state === "ended" || atStart.state === "gone" ? number + 1 : number;
}

/** The refusals of `nuka step` itself: it did nothing. */
export type StepRefusalCode = "walk-not-found" | "pause-not-current" | "pause-answered";

export type StepDecision =
  | { readonly kind: "write-answer" }
  | { readonly kind: "wait" }
  | { readonly kind: "report"; readonly seen: WalkSeen }
  | { readonly kind: "refuse"; readonly code: StepRefusalCode; readonly message: string; readonly do?: string };

/** `now` as an answer to walk `target` sees it: once a newer walk has
 * replaced that walk, there is nothing of it left to answer. */
export function seenAs(target: number, now: WalkSeen): WalkSeen {
  if (now.state === "none") return now;
  const last = now.state === "gone" ? now.last : now;
  return last.number > target ? { state: "none", last } : now;
}

function whereText(seen: WalkState): string {
  if (seen.state === "paused") return `the walk is at pause ${seen.pause.pause}`;
  if (seen.state === "running") return seen.after === 0 ? "the walk is running its first step" : `the walk is running the step after pause ${seen.after}`;
  if (seen.state === "starting") return "the walk has not reached its first pause";
  return "the walk ended";
}

/**
 * What one `nuka step` call does next, from walk.json as it stands now
 * (`seen`), the walk the call is about (`target`, from `callTarget`), and
 * the answers that walk's run directory holds. Pure, so that repeating a
 * call is a property test: an answer already given the same way reports
 * where the walk went from it, and writes nothing again.
 */
export function stepDecision(call: StepCall, target: number, seen: WalkSeen, answers: ReadonlyMap<number, WalkAnswer>): StepDecision {
  if (call.kind === "wait") {
    const number = numberOf(seen);
    if (number === null || number < target) return { kind: "wait" };
    if (seen.state === "starting" || seen.state === "running") return { kind: "wait" };
    return { kind: "report", seen };
  }
  const now = seenAs(target, seen);
  if (now.state === "none") {
    return {
      kind: "refuse",
      code: "walk-not-found",
      message: now.last === null ? "no walk to answer: nuka run --step has not started one in this project" : "no walk to answer: the walk this answer is for was replaced by a later one",
    };
  }
  if (now.state === "gone") return { kind: "report", seen: now };
  const given = answers.get(call.pause);
  if (given !== undefined && given !== call.answer) {
    return {
      kind: "refuse",
      code: "pause-answered",
      message: `pause ${call.pause} was already answered ${given}, so this ${call.answer} changes nothing`,
      do: "nuka step wait",
    };
  }
  if (given === undefined) {
    if (now.state === "paused" && now.pause.pause === call.pause) return { kind: "write-answer" };
    return {
      kind: "refuse",
      code: "pause-not-current",
      message: `pause ${call.pause} is not the pause the walk waits at: ${whereText(now)}`,
      ...(now.state === "ended" ? {} : { do: "nuka step wait" }),
    };
  }
  // Given this way already: a repeat, or this call's own write. Wait until
  // the run has read it and moved on.
  if (now.state === "ended") return { kind: "report", seen: now };
  if (now.state === "paused" && now.pause.pause > call.pause) return { kind: "report", seen: now };
  return { kind: "wait" };
}

/** What `nuka step` prints beside the envelope's five fields, its
 * findings, and its exit code: 0 for a walk paused, running, or ended
 * green; 1 for one ended red, interrupted, or gone. */
export interface StepReport {
  readonly exitCode: 0 | 1;
  readonly findings: readonly Finding[];
  readonly fields: Readonly<Record<string, unknown>>;
}

function runFields(state: WalkState): Partial<WalkRun> {
  if (state.state === "starting") return {};
  const { run_id, run_dir, scenario, world } = state;
  return {
    ...(run_id === undefined ? {} : { run_id }),
    ...(run_dir === undefined ? {} : { run_dir }),
    ...(scenario === undefined ? {} : { scenario }),
    ...(world === undefined ? {} : { world }),
  };
}

/** The command a walk that ended has to be started with again. */
export function restartCommand(target: string): string {
  return `nuka run ${target} --step`;
}

/** The report for a walk as `seen`. A walk still running is one the
 * call's wait ran out on: the call itself is then the `do`, since repeating
 * it is safe. */
export function stepReport(seen: Exclude<WalkSeen, { readonly state: "none" }>, call: StepCall): StepReport {
  if (seen.state === "gone") {
    return {
      exitCode: 1,
      findings: [
        {
          severity: "failed",
          code: "walk-gone",
          message: `the nuka run --step process (pid ${seen.last.pid}) ended without recording how: it was killed or it crashed, so its world and browser may still run`,
          do: restartCommand(seen.last.target),
        },
      ],
      fields: { walk: "gone", last: seen.last },
    };
  }
  if (seen.state === "ended") {
    const findings = seen.end.how === "interrupted" ? [] : seen.end.findings;
    return { exitCode: seen.end.exit_code === 0 ? 0 : 1, findings, fields: { walk: "ended", ...runFields(seen), end: seen.end } };
  }
  if (seen.state === "paused") {
    const { pause } = seen;
    return {
      exitCode: 0,
      findings: [],
      fields: {
        walk: "paused",
        ...runFields(seen),
        pause,
        do: { next: answerCommand(pause.pause, "next"), ...(pause.remaining > 0 ? { stop: answerCommand(pause.pause, "stop") } : {}) },
      },
    };
  }
  const after = seen.state === "running" ? seen.after : 0;
  return {
    exitCode: 0,
    findings: [],
    fields: { walk: "running", ...runFields(seen), after, do: call.kind === "answer" ? answerCommand(call.pause, call.answer) : "nuka step wait" },
  };
}

/** The two lines `nuka run --step` writes on stderr at a pause, outside
 * `--json`. */
export function pauseLines(pause: Pause): string {
  const next = answerCommand(pause.pause, "next");
  const or = pause.remaining > 0 ? `   (or: ${answerCommand(pause.pause, "stop")})` : "";
  return `paused after step ${pause.pause}/${pause.of} (${pause.status}): ${pause.text}\n  do: ${next}${or}\n`;
}
