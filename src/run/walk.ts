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
// the walk and the pause it answers: an answer to a pause nobody was shown,
// or to an earlier walk the same command once answered, is refused, never
// applied to whichever pause is open. Pause numbers only increase, and
// `ended` absorbs every later event, so a replayed answer or a late signal
// cannot move a walk backwards.

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
  /** The step's own status, as its record says. */
  readonly status: "passed" | "failed";
  /** The step record's directory, relative to the run directory. */
  readonly record: string;
  /** Present when the scenario failed at this step: the step itself, or
   * an AfterStep hook after a step that passed. */
  readonly failure?: PauseFailure;
  /** Steps that run on `next`: 0 after the last step, or after a step
   * that failed the scenario, since the steps after it are skipped either
   * way. A stop there skips nothing. */
  readonly remaining: number;
  readonly paused_at: string;
  readonly views: readonly PageView[];
}

/** What failed the scenario at a pause: the step, or an AfterStep hook
 * after a step that passed. A step that failed keeps its own message, as
 * the run's failure does. An AfterStep hook takes no name, so none is
 * kept. */
export interface PauseFailure {
  readonly by: "step" | "hook";
  readonly message: string;
}

/** One line on what failed the scenario at `pause`. */
export function failureText(pause: Pause & { readonly failure: PauseFailure }): string {
  const { failure } = pause;
  const message = failure.message.split("\n")[0] ?? "";
  return failure.by === "step" ? `step ${pause.pause} failed: ${message}` : `an AfterStep hook after step ${pause.pause} failed: ${message}`;
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
 * `interrupted`: a signal ended the run, which writes no run.json.
 * `error`: the run threw, before or after its scenario began, and
 * `findings` hold the unexpected-error it printed. */
export type WalkEnd =
  | { readonly how: "finished"; readonly exit_code: number; readonly findings: readonly Finding[]; readonly stopped?: ScenarioStop }
  | { readonly how: "not-run"; readonly exit_code: number; readonly findings: readonly Finding[] }
  | { readonly how: "error"; readonly exit_code: number; readonly findings: readonly Finding[] }
  | { readonly how: "interrupted"; readonly exit_code: number; readonly signal: string };

export type WalkState =
  | (WalkStart & { readonly state: "starting" })
  | (WalkStart & WalkRun & { readonly state: "running"; readonly after: number })
  | (WalkStart & WalkRun & { readonly state: "paused"; readonly pause: Pause })
  | (WalkStart &
      Partial<WalkRun> & {
        readonly state: "ended";
        readonly end: WalkEnd;
        readonly ended_at: string;
        /** The last pause the walk reached, 0 when it reached none: an
         * answer to a later pause is no answer to this walk. */
        readonly reached: number;
      });

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
  return { state: "starting", ...startOf(start) };
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
    const reached = state.state === "paused" ? state.pause.pause : state.state === "running" ? state.after : 0;
    return { state: "ended", ...startOf(state), ...run, end: event.end, ended_at: event.at, reached };
  }
  switch (state.state) {
    case "starting":
      if (event.kind === "begun") return { state: "running", ...startOf(state), ...event.run, after: 0 };
      break;
    case "running":
      if (event.kind === "paused" && event.pause.pause > state.after) {
        return { state: "paused", ...startOf(state), ...runOf(state), pause: event.pause };
      }
      break;
    case "paused":
      if (event.kind === "answered" && event.pause === state.pause.pause) {
        return { state: "running", ...startOf(state), ...runOf(state), after: state.pause.pause };
      }
      break;
  }
  throw new WalkTransitionError(`a walk ${state.state} cannot take ${event.kind}`);
}

/** The one spelling of an answer, for the do lines and the refusals. */
export function answerCommand(walk: number, pause: number, answer: WalkAnswer): string {
  return `nuka step ${answer} ${pause} --walk ${walk}`;
}

/** The one spelling of a wait for one walk. */
export function waitCommand(walk: number): string {
  return `nuka step wait --walk ${walk}`;
}

/** walk.json as `nuka step` reads it. A walk whose process is gone without
 * recording its end is `gone`: killed, or crashed. `none`: no walk was
 * ever recorded in the project. */
export type WalkSeen = WalkState | { readonly state: "gone"; readonly last: WalkState } | { readonly state: "none" };

/** A walk `nuka step` can report on: anything but `none`. */
export type WalkFound = Exclude<WalkSeen, { readonly state: "none" }>;

/** What `nuka step` sees in walk.json: a live state whose pid is not
 * alive reads as `gone`. */
export function seeWalk(stored: WalkState | null, isAlive: (pid: number) => boolean): WalkSeen {
  if (stored === null) return { state: "none" };
  if (stored.state !== "ended" && !isAlive(stored.pid)) return { state: "gone", last: stored };
  return stored;
}

function numberOf(seen: WalkFound): number {
  return seen.state === "gone" ? seen.last.number : seen.number;
}

/** One `nuka step` call. An answer names the walk it is for, as the pause
 * showed it, so the same command run again later cannot answer a walk
 * that replaced that one. A wait may name one. */
export type StepCall =
  | { readonly kind: "wait"; readonly walk?: number }
  | { readonly kind: "answer"; readonly walk: number; readonly pause: number; readonly answer: WalkAnswer };

/** The walk one `nuka step` call is about, fixed when the call starts. A
 * wait that names no walk is about the newest walk until some `nuka step`
 * call has reported how that walk ended (`endReported`), and about the
 * next walk after that, which a `nuka run --step` started just before the
 * wait may not have recorded yet. So a walk that ended before anyone
 * looked (a refusal, a signal, a kill) is still reported, and an end is
 * not reported in place of the walk that follows it. */
export function callTarget(call: StepCall, atStart: WalkSeen, endReported: (walk: number) => boolean): number {
  if (call.kind === "answer") return call.walk;
  if (call.walk !== undefined) return call.walk;
  if (atStart.state === "none") return 1;
  const number = numberOf(atStart);
  const over = atStart.state === "ended" || atStart.state === "gone";
  return over && endReported(number) ? number + 1 : number;
}

/** How a walk stands, after its number: "ended: interrupted by SIGTERM,
 * exit 143", "is at pause 2". The text output and the refusals that name
 * a walk share it. */
export function walkStanding(seen: WalkFound): string {
  if (seen.state === "gone") return `is gone: its nuka run --step process (pid ${seen.last.pid}) ended without recording how`;
  if (seen.state === "paused") return `is at pause ${seen.pause.pause}`;
  if (seen.state === "running") return seen.after === 0 ? "is running its first step" : `is running the step after pause ${seen.after}`;
  if (seen.state === "starting") return "is starting";
  return `ended${howEnded(seen.end)}`;
}

// What follows "ended" in a walk's standing.
function howEnded(end: WalkEnd): string {
  if (end.how === "interrupted") return `: interrupted by ${end.signal}, exit ${end.exit_code}`;
  if (end.how === "not-run") return ` before its scenario ran, exit ${end.exit_code}`;
  if (end.how === "error") return ` on an unexpected error, exit ${end.exit_code}`;
  if (end.stopped !== undefined) {
    return `: stopped after step ${end.stopped.after_step}${end.stopped.line === null ? "" : ` (line ${end.stopped.line})`}, exit ${end.exit_code}`;
  }
  return `: the run finished, exit ${end.exit_code}`;
}

/** The message of a wait that found no walk to report before its time ran
 * out: which walk it waited for, and the last walk there is and how it
 * stands, so the caller is not told that nothing ran. */
export function nothingStartedMessage(call: Extract<StepCall, { readonly kind: "wait" }>, seconds: number, seen: WalkSeen): string {
  const waited = call.walk === undefined ? `no new walk started within ${seconds}s` : `walk ${call.walk} did not start within ${seconds}s`;
  if (seen.state === "none") return `${waited}, and this project has recorded no walk`;
  return `${waited}; the last walk, walk ${numberOf(seen)}, ${walkStanding(seen)}`;
}

/** The refusals of `nuka step` itself: it did nothing. */
export type StepRefusalCode = "walk-not-found" | "walk-not-current" | "pause-not-current" | "pause-answered";

export type StepDecision =
  | { readonly kind: "write-answer"; readonly runDir: string }
  | { readonly kind: "wait" }
  | { readonly kind: "report"; readonly seen: WalkFound }
  | { readonly kind: "refuse"; readonly code: StepRefusalCode; readonly message: string; readonly do?: string };

function whereText(seen: Exclude<WalkState, { readonly state: "ended" }>): string {
  if (seen.state === "paused") return `the walk is at pause ${seen.pause.pause}`;
  if (seen.state === "running") return seen.after === 0 ? "the walk is running its first step" : `the walk is running the step after pause ${seen.after}`;
  return "the walk has not reached its first pause";
}

// Where the walk walk.json holds stands, for a refusal that names it.
function currentText(seen: WalkFound): string {
  if (seen.state === "gone") return `walk ${seen.last.number}, which is gone`;
  if (seen.state === "ended") return `walk ${seen.number}, which has ended`;
  if (seen.state === "paused") return `walk ${seen.number}, at pause ${seen.pause.pause}`;
  if (seen.state === "running") return `walk ${seen.number}, running`;
  return `walk ${seen.number}, starting`;
}

// A call that names a walk walk.json no longer holds, or does not hold
// yet: the walk it names was replaced, or the number is not one a pause
// showed. The do is a wait for the walk there is, which answers nothing.
function notCurrent(call: StepCall, target: number, seen: WalkFound): StepDecision {
  const what = call.kind === "answer" ? "this answer" : "this wait";
  return {
    kind: "refuse",
    code: "walk-not-current",
    message: `${what} is for walk ${target}, and the walk in this project is ${currentText(seen)}`,
    do: waitCommand(numberOf(seen)),
  };
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
    if (seen.state === "none" || numberOf(seen) < target) return { kind: "wait" };
    // A wait that names its walk is about that walk alone.
    if (call.walk !== undefined && numberOf(seen) > target) return notCurrent(call, target, seen);
    if (seen.state === "starting" || seen.state === "running") return { kind: "wait" };
    return { kind: "report", seen };
  }
  if (seen.state === "none") return { kind: "refuse", code: "walk-not-found", message: "no walk to answer: nuka run --step has not started one in this project" };
  if (numberOf(seen) !== target) return notCurrent(call, target, seen);
  const now = seen;
  if (now.state === "gone") return { kind: "report", seen: now };
  const given = answers.get(call.pause);
  // A wait that names the walk reports it whatever it came to, an end
  // included, so it is the do of every refusal below.
  if (given !== undefined && given !== call.answer) {
    const ended = now.state === "ended" ? `, and walk ${target} ${walkStanding(now)}` : "";
    return {
      kind: "refuse",
      code: "pause-answered",
      message: `pause ${call.pause} was already answered ${given}${ended}, so this ${call.answer} changes nothing`,
      do: waitCommand(target),
    };
  }
  if (now.state === "ended") {
    // A pause the walk never reached is no answer to it, and a report
    // would read as one.
    if (call.pause > now.reached) {
      const when = now.end.how === "not-run" ? "" : now.reached === 0 ? " before its first pause" : ` after pause ${now.reached}`;
      return {
        kind: "refuse",
        code: "pause-not-current",
        message: `pause ${call.pause} is not a pause of walk ${target}, which ended${when}${howEnded(now.end)}`,
        do: waitCommand(target),
      };
    }
    // Nothing is left to answer, and how the walk ended is what the
    // caller needs: a repeat of the answer that ended it, or an answer
    // that came too late.
    return { kind: "report", seen: now };
  }
  if (given === undefined) {
    if (now.state === "paused" && now.pause.pause === call.pause) return { kind: "write-answer", runDir: now.run_dir };
    return {
      kind: "refuse",
      code: "pause-not-current",
      message: `pause ${call.pause} is not the pause the walk waits at: ${whereText(now)}`,
      do: waitCommand(target),
    };
  }
  // Given this way already: a repeat, or this call's own write. Wait until
  // the run has read it and moved on.
  if (now.state === "paused" && now.pause.pause > call.pause) return { kind: "report", seen: now };
  return { kind: "wait" };
}

/** What `nuka step` prints beside the envelope's five fields, its
 * findings, and its exit code: 0 for a walk paused, starting, running, or
 * ended green; 1 for one paused where its scenario failed, ended red,
 * interrupted, or gone. */
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

/** The report for a walk as `seen`. A walk starting or running is one the
 * call's wait ran out on: the call itself is then the `do`, since repeating
 * it is safe. */
export function stepReport(seen: WalkFound, call: StepCall): StepReport {
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
    // A pause after a failure answers no differently, but what it shows is
    // a red scenario: a caller that reads only the exit code and the
    // findings must not read it as passing.
    const findings: Finding[] =
      pause.failure === undefined
        ? []
        : [{ severity: "failed", code: "walk-failed", message: failureText({ ...pause, failure: pause.failure }), do: answerCommand(seen.number, pause.pause, "next") }];
    return {
      exitCode: findings.length === 0 ? 0 : 1,
      findings,
      fields: {
        walk: "paused",
        ...runFields(seen),
        pause,
        do: {
          next: answerCommand(seen.number, pause.pause, "next"),
          ...(pause.remaining > 0 ? { stop: answerCommand(seen.number, pause.pause, "stop") } : {}),
        },
      },
    };
  }
  // A walk the call's wait ran out on. Starting is its own state: the run
  // has not begun the scenario, so no step is running yet.
  const again = call.kind === "answer" ? answerCommand(call.walk, call.pause, call.answer) : waitCommand(seen.number);
  if (seen.state === "starting") return { exitCode: 0, findings: [], fields: { walk: "starting", do: again } };
  return { exitCode: 0, findings: [], fields: { walk: "running", ...runFields(seen), after: seen.after, do: again } };
}

/** The lines `nuka run --step` writes on stderr at a pause of walk
 * `walk`, outside `--json`: the step, what failed when the scenario failed
 * there, and the answers. */
export function pauseLines(walk: number, pause: Pause): string {
  const next = answerCommand(walk, pause.pause, "next");
  const or = pause.remaining > 0 ? `   (or: ${answerCommand(walk, pause.pause, "stop")})` : "";
  const failed = pause.failure === undefined ? "" : `  failure: ${failureText({ ...pause, failure: pause.failure })}\n`;
  return `paused after step ${pause.pause}/${pause.of} (${pause.status}): ${pause.text}\n${failed}  do: ${next}${or}\n`;
}
