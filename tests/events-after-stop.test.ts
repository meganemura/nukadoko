import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWorldEvents, createEventsReader, type Recounted } from "../src/context/events-file.js";
import { readEvents, tallyInputsOfSlice } from "../src/context/events-read.js";
import type { StampedBoundaryTrace } from "../src/context/observed.js";
import { compareCount, COUNT_COMPARES } from "../src/execution-events/count.js";
import { parseEventLine } from "../src/execution-events/format.js";
import type { EventSelection } from "../src/execution-events/selection.js";
import { createTraceTally, type MaybeCounts } from "../src/execution-events/tally.js";
import type { RunClaim, RunScenario, RunStep } from "../src/record/run-result.js";
import type { EventsReadRecord, EventsSlice } from "../src/record/types.js";
import { afterWorldStop, readingsToRecount, stepJudgedTooEarly, withAfterWorldStop } from "../src/run/events-after-stop.js";
import { executionOutcome } from "../src/run/verdict-table.js";
import { op, PREFIX, render, SPANS, T, traceparent, U } from "./helpers/event-lines.js";

// Responsibility: a claim on a count of execution events, judged again
// once the world stopped (src/run/events-after-stop.ts), over the count
// the world's stop takes of every line of the producer's trace
// (collectWorldEvents in src/context/events-file.ts). The stop's count
// does not depend on where other traces' lines fall; a claim is judged
// again only when lines of the trace arrived after it; and an execution
// whose claim the whole count judges otherwise is `broke` in its cell.

const WRITES: EventSelection = { kind: "db", op: ["insert", "update", "delete", "other"], committed: true };
const NO_MAYBE: MaybeCounts = { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, commit_unknown: 0, unowned: 0 };
const OF = { step_record_id: "step-1", step: "place-score", line: 4 };
const scores = (lines: number) => ({ kind: "db" as const, fields: { op: "insert", table: "scores" }, lines });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-after-stop-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (trace: string, fields: Record<string, unknown>): string => JSON.stringify({ trace: traceparent(trace, SPANS[0]!), ...fields });
const requestLine = (trace = T) => line(trace, { kind: "request", id: "5a0f3c9e1b7d2486", method: "POST", route: "/scores", status: 303 });
const insertLine = (trace = T) => line(trace, { kind: "db", table: "scores", op: "insert", committed: true });
const append = (file: string, texts: readonly string[]): void => appendFileSync(file, texts.map((text) => `${text}\n`).join(""));

const producerTrace: StampedBoundaryTrace = { traceId: T, stamped: 1, lastStampAt: undefined, spans: [SPANS[0]!], spansNotKept: 0, processes: 0, processSpans: [] } as unknown as StampedBoundaryTrace;

function readRecord(over: Partial<EventsReadRecord> = {}): EventsReadRecord {
  return { of: OF, trace_id: T, count: WRITES, range: { at_least: 1, at_most: 1 }, counted: [scores(1)], whole: true, open: [], maybe: NO_MAYBE, lines: 2, unreadable: 0, unowned: 0, file: "events-read.jsonl", waited_ms: 3, ...over };
}

function claimOn(key: string, over: Record<string, unknown> = {}): RunClaim {
  return {
    actual: 1,
    actual_from: `events:${key}`,
    compare: "equal",
    expected: 1,
    expected_from: "literal:once",
    expected_text: "once",
    outcome: "held",
    measured: { step_record_id: "step-2", channel: `events_read.${key}` },
    ...over,
  } as RunClaim;
}

function scenarioOf(slice: EventsSlice | null, readings: Readonly<Record<string, EventsReadRecord>>, claims: readonly RunClaim[]): RunScenario {
  const producer = { line: 4, text: "a score is placed", step: "place-score", status: "passed", step_record_id: "step-1", record: "steps/step-1", observed: { events: slice } } as unknown as RunStep;
  const reader = { line: 5, text: "the score row was inserted once", step: "inserted", status: "passed", step_record_id: "step-2", record: "steps/step-2", events_read: readings, claims } as unknown as RunStep;
  return {
    scenario_record_id: "scn-1",
    feature: "features/score.feature",
    line: 3,
    scenario: "placing a score",
    environment: "default",
    status: "passed",
    started_at: "2026-10-29T00:00:00.000Z",
    finished_at: "2026-10-29T00:00:01.000Z",
    steps: [producer, reader],
    hooks: [],
    claims: { held: 1, broken: 0 },
  };
}

const recountedOf = (yes: number, lines: number, over: Partial<Recounted> = {}): Recounted => ({
  lines,
  unreadable: 0,
  count: { yes, maybe: NO_MAYBE, counted: yes === 0 ? [] : [scores(yes)] },
  open: [],
  ...over,
});

describe("the world's stop counts a reading again", () => {
  it("counts the line that arrived after the claim, and the cell of the claim that held on fewer lines is broke", async () => {
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, "");
    const reader = createEventsReader(file, PREFIX, []);
    const slice = await reader.slice(path.join(dir, "producer"), producerTrace);
    append(file, [insertLine(), requestLine()]);
    const readings = await readEvents([{ key: "writes", producer: { source: "live", of: OF, start: reader.producer(T)!, file: reader.world }, selection: WRITES }], {
      until: Date.now() + 1500,
      dir: path.join(dir, "reader"),
      secrets: [],
    });
    expect(readings.writes).toMatchObject({ range: { at_least: 1, at_most: 1 }, whole: true, lines: 2 });
    // A second insert of the same request, written after the claim read.
    append(file, [insertLine()]);

    const scenario = scenarioOf(slice, readings, [claimOn("writes"), claimOn("writes", { measured: { step_record_id: "step-2", channel: "observed.http" } })]);
    const { places, recounts } = readingsToRecount([scenario]);
    expect(places).toEqual([{ scenario: 0, step: 1, key: "writes" }]);
    expect(recounts).toEqual([{ traceId: T, inputs: tallyInputsOfSlice(slice), selection: WRITES, replaced: false }]);
    const { recounted } = collectWorldEvents(file, PREFIX, [], [], path.join(dir, "world", "events.jsonl"), recounts);
    expect(recounted).toEqual([{ lines: 3, unreadable: 0, count: { yes: 2, maybe: NO_MAYBE, counted: [scores(2)] }, open: [] }]);

    const judged = withAfterWorldStop(scenario, (step, key) => (step === 1 && key === "writes" ? recounted[0] : undefined));
    expect(judged.steps[1]!.claims).toEqual([
      {
        ...claimOn("writes"),
        after_world_stop: {
          lines: 3,
          range: { at_least: 2, at_most: 2 },
          outcome: "broken",
          reason:
            '1 line of the trace of step "place-score" arrived after this claim was judged on 2 lines, and the stop counted 1 more line: db insert into scores; over all 3 lines, the count is exactly 2, so the claim breaks',
        },
      },
      // Measured on another channel: no reading of it to count again.
      claimOn("writes", { measured: { step_record_id: "step-2", channel: "observed.http" } }),
    ]);
    expect(executionOutcome(scenario, () => true)).toEqual({ kind: "pass" });
    expect(executionOutcome(judged, () => true)).toEqual({ kind: "broke", line: 5, reason: "a claim at line 5 was judged before every execution event it counts had arrived" });
  });

  it("counts the same over the producer's lines wherever other traces' lines fall, and names a kind no line of the world reported", () =>
    hegel.test((tc) => {
      const own = tc.draw(gs.arrays(op, { maxSize: 10 })).map((entry) => render(entry, T, U, ""));
      const others = tc.draw(gs.arrays(op, { maxSize: 6 })).map((entry) => render(entry, U, T, ""));
      const stranger = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      const mixed = [...own];
      for (const text of [...others, ...Array.from({ length: stranger }, () => insertLine("9f8e7d6c5b4a39281706f5e4d3c2b1a0"))]) {
        mixed.splice(tc.draw(gs.integers({ minValue: 0, maxValue: mixed.length })), 0, text);
      }
      const file = path.join(dir, `events-${Math.random().toString(16).slice(2)}.jsonl`);
      writeFileSync(file, mixed.map((text) => `${text}\n`).join(""));
      const inputs = { spans: SPANS.slice(0, 2), spansNotKept: 0, ranProcesses: false, processSpans: [] };
      const { recounted } = collectWorldEvents(file, PREFIX, [], [], path.join(dir, "copy.jsonl"), [{ traceId: T, inputs, selection: WRITES, replaced: false }]);

      const alone = createTraceTally({ ...inputs, selections: [WRITES] });
      for (const text of own) {
        const parsed = parseEventLine(text);
        if (parsed.state === "unreadable") alone.damaged();
        else alone.owned(parsed);
      }
      const expected = alone.reading({ truncated: false, replaced: false });
      const { open, ...counted } = recounted[0]!;
      expect(counted).toEqual({ lines: expected.lines, unreadable: expected.unreadable, count: expected.counts[0] });
      const dbReported = mixed.some((text) => parseEventLine(text).state === "event" && (JSON.parse(text) as { kind: string }).kind === "db");
      expect(open.some((gap) => gap.gap === "kind-unreported")).toBe(!dbReported);
      expect(open.filter((gap) => gap.gap !== "kind-unreported")).toEqual(expected.open);
    }));

  it("leaves a reading of a step another world ran, or of nothing, to no recount", () => {
    const slice = { trace_id: T, stamped: 1, stamped_spans: [SPANS[0]!], open: [], process_spans: [] } as unknown as EventsSlice;
    const foreign = readRecord({ trace_id: U });
    const nothing = readRecord({ of: null, trace_id: null, open: [{ gap: "producer-not-run" }] });
    expect(readingsToRecount([scenarioOf(slice, { foreign, nothing }, [])])).toEqual({ places: [], recounts: [] });
    const replaced = readRecord({ whole: false, open: [{ gap: "file-replaced" }] });
    expect(readingsToRecount([scenarioOf(slice, { replaced }, [])]).recounts).toEqual([
      { traceId: T, inputs: { spans: [SPANS[0]], spansNotKept: 0, ranProcesses: false, processSpans: [] }, selection: WRITES, replaced: true },
    ]);
  });
});

describe("afterWorldStop", () => {
  const compare = gs.sampledFrom(COUNT_COMPARES);

  it("judges nothing again when no line of the trace arrived after the claim", () =>
    hegel.test((tc) => {
      const judged = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
      const unreadable = tc.draw(gs.integers({ minValue: 0, maxValue: judged }));
      const claim = claimOn("writes", { compare: tc.draw(compare), expected: tc.draw(gs.integers({ minValue: 0, maxValue: 8 })), outcome: tc.draw(gs.sampledFrom(["held", "broken", "unjudged"])) });
      const read = readRecord({ lines: judged - unreadable, unreadable });
      const recounted = recountedOf(tc.draw(gs.integers({ minValue: 0, maxValue: judged })), judged - unreadable, { unreadable });
      expect(afterWorldStop(claim, read, recounted)).toBeUndefined();
    }));

  it("judges a whole count over every line as its one number does", () =>
    hegel.test((tc) => {
      const judged = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
      const all = judged + tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const yes = tc.draw(gs.integers({ minValue: 0, maxValue: all }));
      const which = tc.draw(compare);
      const expected = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
      const after = afterWorldStop(claimOn("writes", { compare: which, expected }), readRecord({ lines: judged }), recountedOf(yes, all));
      expect(after).toMatchObject({ lines: all, range: { at_least: yes, at_most: yes }, outcome: compareCount(yes, which, expected) ? "held" : "broken" });
    }));

  it("keeps the lines no step owns in the reading's window, and says why a count that is still open answers nothing", () => {
    const read = readRecord({ lines: 1, maybe: { ...NO_MAYBE, unowned: 1 } });
    expect(afterWorldStop(claimOn("writes", { compare: "equal", expected: 0 }), read, recountedOf(0, 2))).toEqual({
      lines: 2,
      range: { at_least: 0, at_most: 1 },
      outcome: "unjudged",
      reason: '1 line of the trace of step "place-score" arrived after this claim was judged on 1 line; 1 line carries no step\'s trace id and may be the step\'s, so the count is between 0 and 1, and equal 0 is not known',
    });
    const pending = recountedOf(1, 3, { open: [{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }] });
    expect(afterWorldStop(claimOn("writes", { compare: "at-least", expected: 1 }), readRecord({ lines: 1 }), pending)).toMatchObject({ range: { at_least: 1, at_most: null }, outcome: "held" });
  });

  it("names what the whole count counted that the claim's did not, and nothing when it counted no more", () => {
    const rankings = { kind: "db" as const, fields: { op: "update", table: "rankings" }, lines: 1 };
    const more = afterWorldStop(claimOn("writes", { compare: "equal", expected: 1 }), readRecord({ lines: 1 }), recountedOf(3, 4, { count: { yes: 3, maybe: NO_MAYBE, counted: [scores(2), rankings] } }));
    expect(more?.reason).toBe(
      '3 lines of the trace of step "place-score" arrived after this claim was judged on 1 line, and the stop counted 2 more lines: 1 db insert into scores, 1 db update rankings; over all 4 lines, the count is exactly 3, so the claim breaks',
    );
    const fewer = afterWorldStop(claimOn("writes", { compare: "equal", expected: 1 }), readRecord({ lines: 1 }), recountedOf(0, 2));
    expect(fewer?.reason).toBe('1 line of the trace of step "place-score" arrived after this claim was judged on 1 line; over all 2 lines, the count is exactly 0, so the claim breaks');
  });

  it("judges again no claim that is not on a count, and none that observed nothing", () => {
    const recounted = recountedOf(2, 5);
    expect(afterWorldStop(claimOn("writes", { compare: "contains-text", expected: "x" }), readRecord(), recounted)).toBeUndefined();
    expect(afterWorldStop(claimOn("writes", { expected: "1" }), readRecord(), recounted)).toBeUndefined();
    expect(afterWorldStop(claimOn("writes", { outcome: "unobserved" }), readRecord(), recounted)).toBeUndefined();
  });
});

describe("stepJudgedTooEarly", () => {
  it("names the first step whose claim the stop judged otherwise, and no step when every claim kept its outcome", () => {
    const kept = claimOn("writes", { after_world_stop: { lines: 3, range: { at_least: 1, at_most: 1 }, outcome: "held", reason: "kept" } });
    const moved = claimOn("writes", { after_world_stop: { lines: 3, range: { at_least: 2, at_most: 2 }, outcome: "broken", reason: "moved" } });
    const steps = (claims: readonly RunClaim[]) => scenarioOf(null, {}, claims).steps;
    expect(stepJudgedTooEarly(steps([kept, claimOn("writes")]))).toBe(-1);
    expect(stepJudgedTooEarly(steps([kept, moved]))).toBe(1);
  });
});
