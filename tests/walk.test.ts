import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  advanceWalk,
  callTarget,
  pauseLines,
  seeWalk,
  startWalk,
  stepDecision,
  stepReport,
  WalkTransitionError,
  type Pause,
  type PauseFailure,
  type StepCall,
  type WalkAnswer,
  type WalkEnd,
  type WalkEvent,
  type WalkRun,
  type WalkState,
} from "../src/run/walk.js";

// Responsibility: the walk's model as nuka run --step and nuka step share
// it. Properties over any sequence of events: a walk moves only by its
// table, its pause numbers only increase, an answer moves only the pause it
// names, ended absorbs, and repeating a nuka step call never writes an
// answer twice or turns a given answer into a refusal.

const START = { number: 3, pid: 4242, target: "features/order.feature:3", started_at: "2026-10-29T10:00:00.000Z" };
const RUN: WalkRun = {
  run_id: "run-20261029-100000-abcd",
  run_dir: ".nukadoko/runs/run-20261029-100000-abcd",
  scenario: { feature: "features/order.feature", line: 3, name: "an order is placed", environment: "default" },
  world: null,
};
const STEPS = 5;

const FAILURES: readonly (PauseFailure | undefined)[] = [
  undefined,
  { by: "step", message: "expected 2 items\nat line 7" },
  { by: "hook", message: "the page closed" },
];

function pauseAt(k: number, remaining: number, failure?: PauseFailure): Pause {
  return {

    pause: k,
    of: STEPS,
    line: 3 + k,
    text: `step ${k}`,
    step: `step-${k}`,
    status: "passed",
    record: `steps/stp-${k}`,
    remaining,
    paused_at: "2026-10-29T10:00:01.000Z",
    views: [],
    ...(failure === undefined ? {} : { failure, status: failure.by === "step" ? "failed" : "passed" }),
  };
}

const ENDS: readonly WalkEnd[] = [
  { how: "finished", exit_code: 0, findings: [] },
  { how: "finished", exit_code: 1, findings: [], stopped: { after_step: 2, line: 5 } },
  { how: "not-run", exit_code: 2, findings: [] },
  { how: "error", exit_code: 1, findings: [{ severity: "error", code: "unexpected-error", message: "the sink broke" }] },
  { how: "interrupted", exit_code: 130, signal: "SIGINT" },
];

const events: gs.Generator<WalkEvent> = gs.oneOf(
  gs.just({ kind: "begun", run: RUN } as const),
  gs
    .tuples(gs.integers({ minValue: 0, maxValue: STEPS + 1 }), gs.integers({ minValue: 0, maxValue: STEPS }), gs.sampledFrom(FAILURES))
    .map(([k, remaining, failure]): WalkEvent => ({ kind: "paused", pause: pauseAt(k, failure === undefined ? remaining : 0, failure) })),
  gs
    .tuples(gs.integers({ minValue: 0, maxValue: STEPS + 1 }), gs.sampledFrom(["next", "stop"] as const))
    .map(([k, answer]): WalkEvent => ({ kind: "answered", pause: k, answer })),
  gs.sampledFrom(ENDS).map((end): WalkEvent => ({ kind: "ended", end, at: "2026-10-29T10:05:00.000Z" })),
);

// The table, written apart from advanceWalk's code, so the property checks
// one against the other.
function takes(state: WalkState, event: WalkEvent): boolean {
  if (state.state === "ended" || event.kind === "ended") return true;
  if (state.state === "starting") return event.kind === "begun";
  if (state.state === "running") return event.kind === "paused" && event.pause.pause > state.after;
  return event.kind === "answered" && event.pause === state.pause.pause;
}

// Every state a walk passes through for `sequence`, skipping the events it
// refuses, from its first state.
function walkThrough(sequence: readonly WalkEvent[]): WalkState[] {
  const states = [startWalk(START)];
  for (const event of sequence) {
    try {
      states.push(advanceWalk(states.at(-1)!, event));
    } catch (error) {
      if (!(error instanceof WalkTransitionError)) throw error;
    }
  }
  return states;
}

// A walk the run moved to pause `k` with next at each pause before it, and
// then `then` more: none, the answer applied, or that answer and the next
// pause or the end.
function walkTo(k: number, answer: WalkAnswer, then: "paused" | "answered" | "next-pause" | "ended"): { seen: WalkState; answers: Map<number, WalkAnswer> } {
  let state = advanceWalk(startWalk(START), { kind: "begun", run: RUN });
  const answers = new Map<number, WalkAnswer>();
  for (let pause = 1; pause < k; pause += 1) {
    state = advanceWalk(state, { kind: "paused", pause: pauseAt(pause, STEPS - pause) });
    answers.set(pause, "next");
    state = advanceWalk(state, { kind: "answered", pause, answer: "next" });
  }
  state = advanceWalk(state, { kind: "paused", pause: pauseAt(k, STEPS - k) });
  if (then === "paused") return { seen: state, answers };
  answers.set(k, answer);
  state = advanceWalk(state, { kind: "answered", pause: k, answer });
  if (then === "next-pause") state = advanceWalk(state, { kind: "paused", pause: pauseAt(k + 1, STEPS - k - 1) });
  if (then === "ended") state = advanceWalk(state, { kind: "ended", end: ENDS[answer === "stop" ? 1 : 0]!, at: "2026-10-29T10:05:00.000Z" });
  return { seen: state, answers };
}

describe("advanceWalk", () => {
  it("takes exactly the transitions of the walk's table, and throws for every other pair", () =>
    hegel.test((tc) => {
      const sequence = tc.draw(gs.arrays(events, { maxSize: 16 }));
      let state = startWalk(START);
      for (const event of sequence) {
        if (takes(state, event)) {
          state = advanceWalk(state, event);
        } else {
          expect(() => advanceWalk(state, event)).toThrow(WalkTransitionError);
        }
      }
    }));

  it("only increases a walk's pause numbers, keeps its start, and never returns to starting", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 16 })));
      const pauses = states.flatMap((state) => (state.state === "paused" ? [state.pause.pause] : []));
      for (let index = 1; index < pauses.length; index += 1) expect(pauses[index]!).toBeGreaterThan(pauses[index - 1]!);
      for (const state of states) {
        expect([state.number, state.pid, state.target, state.started_at]).toEqual([START.number, START.pid, START.target, START.started_at]);
      }
      expect(states.slice(1).map((state) => state.state)).not.toContain("starting");
    }));

  it("moves a paused walk only with an answer that names its pause, to running after that pause", () =>
    hegel.test((tc) => {
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS }));
      const named = tc.draw(gs.integers({ minValue: 0, maxValue: STEPS + 1 }));
      const answer = tc.draw(gs.sampledFrom(["next", "stop"] as const));
      const { seen } = walkTo(k, answer, "paused");
      if (named === k) {
        expect(advanceWalk(seen, { kind: "answered", pause: named, answer })).toMatchObject({ state: "running", after: k });
      } else {
        expect(() => advanceWalk(seen, { kind: "answered", pause: named, answer })).toThrow(WalkTransitionError);
      }
    }));

  it("absorbs every event once ended, so a replayed answer or a late signal changes nothing", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 16 })));
      const ended = states.findIndex((state) => state.state === "ended");
      if (ended === -1) return;
      for (const state of states.slice(ended)) expect(state).toBe(states[ended]);
      const later = tc.draw(events);
      expect(advanceWalk(states[ended]!, later)).toBe(states[ended]);
    }));
});

describe("seeWalk", () => {
  it("reads a live walk whose process is not alive as gone, and an ended walk as ended whatever its pid", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const state = states.at(-1)!;
      const alive = tc.draw(gs.booleans());
      const seen = seeWalk(state, () => alive);
      if (state.state === "ended" || alive) expect(seen).toBe(state);
      else expect(seen).toEqual({ state: "gone", last: state });
      expect(seeWalk(null, () => alive)).toEqual({ state: "none" });
    }));
});

describe("stepDecision", () => {
  it("writes an answer only at the pause the walk waits at, when that pause has none", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const seen = seeWalk(states.at(-1)!, () => tc.draw(gs.booleans()));
      const answers = new Map(tc.draw(gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: STEPS + 1 }), gs.sampledFrom(["next", "stop"] as const)), { maxSize: 4 })));
      const call: StepCall = { kind: "answer", walk: START.number, pause: tc.draw(gs.integers({ minValue: 0, maxValue: STEPS + 1 })), answer: tc.draw(gs.sampledFrom(["next", "stop"] as const)) };
      if (stepDecision(call, START.number, seen, answers).kind !== "write-answer") return;
      expect(seen.state === "paused" && seen.pause.pause === call.pause).toBe(true);
      expect(answers.has(call.pause)).toBe(false);
    }));

  it("never writes a repeated answer again or refuses it, whether the run has read it, moved on, or ended", () =>
    hegel.test((tc) => {
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS - 1 }));
      const answer = tc.draw(gs.sampledFrom(["next", "stop"] as const));
      const call: StepCall = { kind: "answer", walk: START.number, pause: k, answer };
      const paused = walkTo(k, answer, "paused");
      expect(stepDecision(call, START.number, paused.seen, paused.answers)).toEqual({ kind: "write-answer", runDir: RUN.run_dir });
      // The answer is on disk, and the run has not read it yet.
      const written = new Map(paused.answers).set(k, answer);
      expect(stepDecision(call, START.number, paused.seen, written)).toEqual({ kind: "wait" });
      // A stop with steps left ends the walk, so it never pauses again.
      const thens = answer === "stop" ? (["answered", "ended"] as const) : (["answered", "next-pause", "ended"] as const);
      for (const then of thens) {
        const { seen, answers } = walkTo(k, answer, then);
        expect(stepDecision(call, START.number, seen, answers)).toEqual(then === "answered" ? { kind: "wait" } : { kind: "report", seen });
      }
    }));

  it("refuses the other answer to a pause already answered, wherever the walk went from it", () =>
    hegel.test((tc) => {
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS - 1 }));
      const answer = tc.draw(gs.sampledFrom(["next", "stop"] as const));
      const then = tc.draw(gs.sampledFrom(["answered", "next-pause", "ended"] as const));
      const { seen, answers } = walkTo(k, answer, then);
      const other: WalkAnswer = answer === "next" ? "stop" : "next";
      expect(stepDecision({ kind: "answer", walk: START.number, pause: k, answer: other }, START.number, seen, answers)).toMatchObject({ kind: "refuse", code: "pause-answered" });
    }));

  it("refuses an answer to a pause nobody was shown or that has passed without one", () =>
    hegel.test((tc) => {
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS }));
      const named = tc.draw(gs.integers({ minValue: 0, maxValue: STEPS + 1 }));
      const answer = tc.draw(gs.sampledFrom(["next", "stop"] as const));
      const { seen, answers } = walkTo(k, answer, "paused");
      if (named === k || answers.has(named)) return;
      expect(stepDecision({ kind: "answer", walk: START.number, pause: named, answer }, START.number, seen, answers)).toMatchObject({ kind: "refuse", code: "pause-not-current" });
    }));

  it("reports an ended walk to an answer to a pause it reached that does not contradict one given, and refuses a pause it never reached", () =>
    hegel.test((tc) => {
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS - 1 }));
      const answer = tc.draw(gs.sampledFrom(["next", "stop"] as const));
      const { seen, answers } = walkTo(k, answer, "ended");
      expect(seen).toMatchObject({ state: "ended", reached: k });
      const call: StepCall = { kind: "answer", walk: START.number, pause: tc.draw(gs.integers({ minValue: 1, maxValue: STEPS + 1 })), answer: tc.draw(gs.sampledFrom(["next", "stop"] as const)) };
      const given = answers.get(call.pause);
      const decision = stepDecision(call, START.number, seen, answers);
      const wait = `nuka step wait --walk ${START.number}`;
      if (given !== undefined && given !== call.answer) expect(decision).toEqual({ kind: "refuse", code: "pause-answered", message: expect.any(String), do: wait });
      else if (call.pause > k) expect(decision).toEqual({ kind: "refuse", code: "pause-not-current", message: expect.any(String), do: wait });
      else expect(decision).toEqual({ kind: "report", seen });
    }));

  it("refuses an answer for any walk but the one walk.json holds, naming that walk, and reports a gone walk", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const seen = seeWalk(states.at(-1)!, () => tc.draw(gs.booleans()));
      const answers = new Map(tc.draw(gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: STEPS + 1 }), gs.sampledFrom(["next", "stop"] as const)), { maxSize: 4 })));
      const walk = tc.draw(gs.integers({ minValue: 1, maxValue: START.number + 2 }));
      const call: StepCall = { kind: "answer", walk, pause: tc.draw(gs.integers({ minValue: 1, maxValue: STEPS })), answer: tc.draw(gs.sampledFrom(["next", "stop"] as const)) };
      const decision = stepDecision(call, callTarget(call, seen, () => false), seen, answers);
      if (walk === START.number) {
        expect(decision).not.toMatchObject({ code: "walk-not-current" });
        if (seen.state === "gone") expect(decision).toEqual({ kind: "report", seen });
        return;
      }
      expect(decision).toMatchObject({ kind: "refuse", code: "walk-not-current", do: `nuka step wait --walk ${START.number}` });
      if (decision.kind === "refuse") expect(decision.message).toContain(`this answer is for walk ${walk}, and the walk in this project is walk ${START.number}`);
    }));

  it("makes a wait that names no walk report the newest walk once it pauses, or once it is over unless its end was reported, and wait otherwise", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const state = states.at(-1)!;
      const alive = tc.draw(gs.booleans());
      const reported = tc.draw(gs.booleans());
      const seen = seeWalk(state, () => alive);
      const target = callTarget({ kind: "wait" }, seen, () => reported);
      const decision = stepDecision({ kind: "wait" }, target, seen, new Map());
      const over = seen.state === "ended" || seen.state === "gone";
      if (seen.state === "paused" || (over && !reported)) expect(decision).toEqual({ kind: "report", seen });
      else expect(decision).toEqual({ kind: "wait" });
      expect(callTarget({ kind: "wait" }, { state: "none" }, () => reported)).toBe(1);
      // A later walk, once it pauses, is what any wait reports.
      const next = { ...walkTo(1, "next", "paused").seen, number: START.number + 1 };
      expect(stepDecision({ kind: "wait" }, target, startWalk({ ...START, number: START.number + 1 }), new Map())).toEqual({ kind: "wait" });
      expect(stepDecision({ kind: "wait" }, target, next, new Map())).toEqual({ kind: "report", seen: next });
    }));

  it("makes a wait that names a walk report that walk whatever was reported, wait for one not recorded yet, and refuse one a later walk replaced", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const seen = seeWalk(states.at(-1)!, () => tc.draw(gs.booleans()));
      const walk = tc.draw(gs.integers({ minValue: 1, maxValue: START.number + 2 }));
      const call = { kind: "wait", walk } as const;
      const decision = stepDecision(call, callTarget(call, seen, () => true), seen, new Map());
      if (walk > START.number) expect(decision).toEqual({ kind: "wait" });
      else if (walk < START.number) expect(decision).toMatchObject({ kind: "refuse", code: "walk-not-current", do: `nuka step wait --walk ${START.number}` });
      else if (seen.state === "starting" || seen.state === "running") expect(decision).toEqual({ kind: "wait" });
      else expect(decision).toEqual({ kind: "report", seen });
    }));
});

describe("stepReport", () => {
  it("exits 0 for a walk paused, running, or ended green, and 1 for one paused after a failure, ended red, interrupted, or gone, and offers stop only while a step remains", () =>
    hegel.test((tc) => {
      const states = walkThrough(tc.draw(gs.arrays(events, { maxSize: 12 })));
      const state = states.at(-1)!;
      const seen = seeWalk(state, () => tc.draw(gs.booleans()));
      if (seen.state === "none") return;
      const report = stepReport(seen, { kind: "wait" });
      const red = seen.state === "gone" || (seen.state === "ended" && seen.end.exit_code !== 0) || (seen.state === "paused" && seen.pause.failure !== undefined);
      expect(report.exitCode).toBe(red ? 1 : 0);
      // A pause after a failure is red, names what failed, and still offers next.
      if (seen.state === "paused") {
        const failure = seen.pause.failure;
        expect(report.findings.map((finding) => [finding.severity, finding.code, finding.do])).toEqual(
          failure === undefined ? [] : [["failed", "walk-failed", `nuka step next ${seen.pause.pause} --walk ${START.number}`]],
        );
        if (failure !== undefined) expect(report.findings[0]!.message).toContain(failure.by === "step" ? `step ${seen.pause.pause} failed` : "AfterStep hook");
      }
      if (seen.state === "paused") {
        expect(report.fields["do"]).toEqual({
          next: `nuka step next ${seen.pause.pause} --walk ${START.number}`,
          ...(seen.pause.remaining > 0 ? { stop: `nuka step stop ${seen.pause.pause} --walk ${START.number}` } : {}),
        });
      }
      if (seen.state === "gone") expect(report.findings.map((finding) => [finding.code, finding.do])).toEqual([["walk-gone", `nuka run ${START.target} --step`]]);
      // An end carries what the run printed, an unexpected error included.
      if (seen.state === "ended" && seen.end.how !== "interrupted") expect(report.findings).toEqual(seen.end.findings);
      // A walk that has not begun its scenario runs no step yet.
      expect(report.fields["walk"]).toBe(seen.state);
    }));
});

describe("pauseLines", () => {
  it("names the pause, its step, and the commands that answer it, and leaves stop out after the last step", () => {
    expect(pauseLines(3, pauseAt(2, 3))).toBe("paused after step 2/5 (passed): step 2\n  do: nuka step next 2 --walk 3   (or: nuka step stop 2 --walk 3)\n");
    expect(pauseLines(3, pauseAt(5, 0))).toBe("paused after step 5/5 (passed): step 5\n  do: nuka step next 5 --walk 3\n");
    expect(pauseLines(3, pauseAt(2, 0, { by: "hook", message: "the page closed" }))).toBe(
      "paused after step 2/5 (passed): step 2\n  failure: an AfterStep hook after step 2 failed: the page closed\n  do: nuka step next 2 --walk 3\n",
    );
    expect(pauseLines(3, pauseAt(2, 0, { by: "step", message: "expected 2 items\nat line 7" }))).toBe(
      "paused after step 2/5 (failed): step 2\n  failure: step 2 failed: expected 2 items\n  do: nuka step next 2 --walk 3\n",
    );
  });
});
