import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COUNT_COMPARES, judgeRange, type CountCompare, type CountRange } from "../src/execution-events/count.js";
import type { EventsGap, MaybeCounts } from "../src/execution-events/tally.js";
import { withMeasured } from "../src/run/measured.js";
import { CLAIM_COMPARES, claimsProblem, eventsShapeOf, type Claim, type ClaimStepShape } from "../src/step/claims.js";
import { defineStep, isClaimStep } from "../src/step/define-step.js";
import { evaluateClaims, judgingBudget, readerNow, type ClaimInputs, type EventsCountSide } from "../src/step/evaluate-claims.js";

// Responsibility: a claim on a count of execution events (docs/spec.md
// "Execution events"), from its declaration to its record. defineStep and
// the claim rules refuse an `events` key, and a claim that reads one, that
// the run would judge one way on every line; a claim holds or breaks only
// when every count in the range the step read gives that answer, however
// the pattern states the number; and the record names the count as one
// number only when the range is one, and the reading's channel as where
// it was measured. The run that reads the lines is
// tests/events-claims-run.test.ts's.

const NO_MAYBE: MaybeCounts = { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, commit_unknown: 0, unowned: 0 };
const WRITES = { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } as const;
const LABEL = "events:post@4 count db where op in [insert, update, delete, other], committed true";
const COMPARES_LISTED = COUNT_COMPARES.join(", ");

const producer = defineStep({ pattern: "the client posts", description: "post", args: z.object({}), async run() {} });
const other = defineStep({ pattern: "the client gets", description: "get", args: z.object({}), async run() {} });
const EVENTS = { writes: { of: producer, count: WRITES } };

function shapeOf(pattern: string, events: unknown = EVENTS, over: Partial<ClaimStepShape> = {}): ClaimStepShape {
  return {
    patterns: [pattern],
    argsKeys: new Set(),
    requiredArgsKeys: new Set(),
    fromKeys: new Set(),
    captureKeys: new Set(),
    hasObserve: false,
    rewrittenArgs: new Map(),
    stringArgs: new Set(),
    events: eventsShapeOf(events),
    ...over,
  };
}

const onWrites = (compare: string, expected: unknown, over: Record<string, unknown> = {}): Claim => ({ actual: "writes", compare, expected, ...over }) as unknown as Claim;

function inputsWith(side: EventsCountSide, pattern: string, args: Record<string, unknown> = {}): ClaimInputs {
  return {
    args: readerNow(args),
    observed: readerNow(undefined),
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(),
    argSide: (key) => ({ origin: `sentence:${key}`, segments: [], label: `sentence:${key}` }),
    sentenceText: (key) => (key in args ? String(args[key]) : null),
    patterns: [pattern],
    testPattern: async () => ({ reason: "no claim here tests a pattern" }),
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
    events: new Map([["writes", side]]),
  };
}

/** A reading of `range` as the count makes one: a range with no upper
 * bound has a gap open (`gap`), and a wider bounded one has lines that
 * may match. */
const readingSide = (range: CountRange, gap: EventsGap = { gap: "no-requests" }): EventsCountSide => ({
  label: LABEL,
  of: "post@4",
  reading:
    range.at_most === null
      ? { range, whole: false, open: [gap], maybe: NO_MAYBE }
      : { range, whole: true, open: [], maybe: { ...NO_MAYBE, unreadable: range.at_most - range.at_least } },
});

const ranges = gs.composite((tc): CountRange => {
  const low = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
  const high = tc.draw(gs.oneOf<number | null>(gs.just(null), gs.integers({ minValue: low, maxValue: 8 })));
  return { at_least: low, at_most: high };
});

/** How a pattern can state a number: the words, the number they state,
 * and whether they state it under any compare (digits, a number word,
 * once, twice) or fix it under equal alone (a word of the table). */
const STATED: readonly { readonly words: string; readonly value: number; readonly anyCompare: boolean }[] = [
  { words: "3", value: 3, anyCompare: true },
  { words: "three", value: 3, anyCompare: true },
  { words: "zero", value: 0, anyCompare: true },
  { words: "once", value: 1, anyCompare: true },
  { words: "twice", value: 2, anyCompare: true },
  { words: "never", value: 0, anyCompare: false },
  { words: "nothing", value: 0, anyCompare: false },
];

function outcomeOf(range: CountRange, compare: CountCompare, expected: number): string {
  const answer = judgeRange(range, compare, expected);
  return answer === "unknown" ? "unjudged" : answer;
}

describe("a claim that reads a count", () => {
  it("takes the six compares of two numbers, and refuses every other compare by name", () =>
    hegel.test((tc) => {
      const compare = tc.draw(gs.sampledFrom(CLAIM_COMPARES));
      const problem = claimsProblem([onWrites(compare, { literal: 3 })], shapeOf("the rows were written 3 times"));
      if ((COUNT_COMPARES as readonly string[]).includes(compare)) expect(problem).toBeNull();
      else
        expect(problem).toBe(
          `claims[0] reads events.writes, a count of execution events, which is a number, and "${compare}" does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with ${COMPARES_LISTED}`,
        );
    }));

  it("refuses an each, a view, an at, a count, and a path inside the count, since the count is one number", () => {
    expect(claimsProblem([{ actual: "writes", each: { claims: [{ actual: "n", compare: "equal", expected: { literal: 0 } }] } } as unknown as Claim], shapeOf("nothing was written"))).toBe(
      `claims[0] reads events.writes, a count of execution events, which is one number, and each reads the items of an array. Compare the count with ${COMPARES_LISTED}`,
    );
    for (const [key, value] of [["view", "json"], ["at", "a"], ["count", true], ["expected_view", "text"]] as const) {
      expect(claimsProblem([onWrites("equal", { literal: 0 }, { [key]: value })], shapeOf("nothing was written"))).toBe(
        `claims[0] has the key "${key}", which a claim on a count of execution events does not have. It has actual, compare, expected`,
      );
    }
    expect(claimsProblem([{ actual: "writes.lines", compare: "equal", expected: { literal: 0 } }], shapeOf("nothing was written"))).toBe(
      'claims[0].actual reads inside events.writes, a count of execution events, which is one number with nothing inside it. Name the key alone: actual "writes"',
    );
  });

  it("refuses an expected value that is never a number", () => {
    expect(claimsProblem([onWrites("equal", { literal: "red" })], shapeOf("the rows were written red"))).toBe(
      'claims[0] reads events.writes, a count of execution events, which is a number, and its expected value is the literal "red", which is never a number, so the claim always breaks. State the number in the pattern, as digits, a number word, once, twice, or a word such as nothing or never, and write it as a number literal',
    );
    const keys = new Set(["n"]);
    expect(claimsProblem([onWrites("equal", "n")], shapeOf("the rows were written {n} times", EVENTS, { argsKeys: keys, requiredArgsKeys: keys, captureKeys: keys, stringArgs: keys }))).toBe(
      "claims[0] reads events.writes, a count of execution events, which is a number, and its expected value is args.n, a plain z.string(), which is never a number, so the claim always breaks. Capture the number with {int}",
    );
  });

  it("refuses an events key that has the name of a from key or an args key, and one no claim reads", () => {
    expect(claimsProblem([onWrites("equal", { literal: 0 })], shapeOf("nothing was written", EVENTS, { fromKeys: new Set(["writes"]) }))).toBe(
      'events.writes has the name of a key of from, so a claim\'s actual "writes" would have two sources. Rename one of them',
    );
    expect(claimsProblem([onWrites("equal", { literal: 0 })], shapeOf("nothing was written", EVENTS, { argsKeys: new Set(["writes"]) }))).toBe(
      'events.writes has the name of an args key, so a claim\'s actual "writes" would have two sources. Rename one of them',
    );
    const two = { ...EVENTS, reads: { of: producer, count: { kind: "db", op: "read" } } };
    expect(claimsProblem([onWrites("equal", { literal: 0 })], shapeOf("nothing was written", two))).toBe(
      'events.reads is read by no claim, so the count it names changes no verdict. Compare a claim with actual "reads", or take the key out of events',
    );
  });

  it("takes a selection value from the sentence as a capture the claims read, and only as an expected sentence key could be", () => {
    const byTable = { writes: { of: producer, count: { kind: "db", table: { sentence: "table" }, op: "insert", committed: true } } };
    const table = new Set(["table"]);
    const claims = [onWrites("equal", { literal: 3 })];
    const pattern = "{table} was written 3 times";
    // The capture is read by the selection, so no claim needs to read it.
    expect(claimsProblem(claims, shapeOf(pattern, byTable, { argsKeys: table, requiredArgsKeys: table, captureKeys: table }))).toBeNull();
    expect(claimsProblem(claims, shapeOf("the table was written 3 times", byTable, { argsKeys: table, requiredArgsKeys: table, fromKeys: table }))).toBe(
      'events.writes.count.table takes { sentence: "table" }, which from fills from an earlier step, and a selection takes a value the line states',
    );
    expect(claimsProblem(claims, shapeOf("the table was written 3 times", byTable))).toBe('events.writes.count.table takes { sentence: "table" }, which is not a key of args');
    expect(claimsProblem(claims, shapeOf(pattern, byTable, { argsKeys: table, captureKeys: table }))).toBe(
      'events.writes.count.table takes { sentence: "table" }, which args lets a line leave out (it is optional or has a default), so step code would fill what the count selects. Make it required',
    );
    expect(claimsProblem(claims, shapeOf(pattern, byTable, { argsKeys: table, requiredArgsKeys: table, captureKeys: table, rewrittenArgs: new Map([["table", "a transform"]]) }))).toMatch(
      /^events\.writes\.count\.table /,
    );
  });
});

describe("defineStep's events", () => {
  const claimStep = (events: unknown) => () =>
    defineStep({ pattern: "nothing was written", args: z.object({}), events, claims: [{ actual: "writes", compare: "equal", expected: { literal: 0 } }] } as never);

  it("keeps a count of one step or of candidates, and gives a claim step with none an empty object", () => {
    const step = claimStep({ writes: { of: [producer, other], count: WRITES } })();
    expect(isClaimStep(step) && step.events.writes!.of).toEqual([producer, other]);
    const none = defineStep({ pattern: "the value is {want:int}", args: z.object({ want: z.number() }), from: { value: [producer, "value"] }, claims: [{ actual: "value", compare: "equal", expected: "want" }] } as never);
    expect(isClaimStep(none) && none.events).toEqual({});
  });

  it("refuses events on a step that acts", () => {
    expect(() => defineStep({ pattern: "a thing", description: "d", args: z.object({}), events: EVENTS, async run() {} } as never)).toThrow(
      "defineStep events belongs to a claim step, and this definition has no claims. A step that acts uses run; a step that judges declares claims.",
    );
  });

  it("refuses a key a claim cannot name, an entry that is not { of, count }, and an of that is no step", () => {
    expect(claimStep([])).toThrow("defineStep events must be an object whose keys name counts, each { of, count }.");
    expect(claimStep({ "writes.all": { of: producer, count: WRITES } })).toThrow('defineStep events key "writes.all" is not one key a claim\'s actual can name; name it with one word and no dot.');
    expect(claimStep({ writes: producer })).toThrow(
      "defineStep events.writes must be an object with of, the step whose events it counts, and count, the lines it counts.",
    );
    expect(claimStep({ writes: { of: producer, count: WRITES, within: 10 } })).toThrow('defineStep events.writes has the key "within", which an events entry does not have. It has of, count.');
    for (const of of [undefined, [], "post", [producer, {}]]) {
      expect(claimStep({ writes: { of, count: WRITES } })).toThrow(
        "defineStep events.writes.of must be a step defineStep returned, or a non-empty list of them; import the step whose events it counts.",
      );
    }
    expect(claimStep({ writes: { of: [producer, producer], count: WRITES } })).toThrow("defineStep events.writes.of names one step twice.");
  });

  it("refuses a selection the format cannot judge: a writer's own kind, a kind it does not define, and a write with no commit state", () => {
    expect(claimStep({ writes: { of: producer, count: { kind: "x_cache" } } })).toThrow(/^defineStep events\.writes\.count\.kind is "x_cache", a writer's own kind/);
    expect(claimStep({ writes: { of: producer, count: { kind: "database" } } })).toThrow(
      'defineStep events.writes.count.kind is "database", which the execution events format does not define; its kinds are request, db, tx, job, http, flag, error.',
    );
    expect(claimStep({ writes: { of: producer, count: { kind: "db", op: "insert" } } })).toThrow(
      "defineStep events.writes.count selects db lines whose op may be a write and does not state committed, so a write that was rolled back would count as written; add committed: true or committed: false.",
    );
    expect(claimStep({ writes: { of: producer } })).toThrow(/^defineStep events\.writes\.count is not an object that names a kind/);
  });
});

describe("judging a count", () => {
  it("holds or breaks only when every count in the range gives that answer, whichever words state the number, and names the count as one number only when the range is one", () =>
    hegel.testAsync(async (tc) => {
      const stated = tc.draw(gs.sampledFrom(STATED));
      const compare = tc.draw(gs.sampledFrom(COUNT_COMPARES));
      const range = tc.draw(ranges);
      const pattern = `the rows were written ${stated.words}`;
      const claim = onWrites(compare, { literal: stated.value });
      const problem = claimsProblem([claim], shapeOf(pattern));
      if (!stated.anyCompare && compare !== "equal") {
        expect(problem).toMatch(new RegExp(`^claims\\[0\\]\\.expected is the literal 0, which the word "${stated.words}" fixes`));
        return;
      }
      expect(problem).toBeNull();
      const [judged] = await evaluateClaims([claim], inputsWith(readingSide(range), pattern));
      const outcome = outcomeOf(range, compare, stated.value);
      expect(judged!.record).toMatchObject({
        actual_from: LABEL,
        compare,
        expected: stated.value,
        expected_from: `literal:${stated.words}`,
        outcome,
      });
      if (range.at_most === range.at_least) {
        expect(judged!.record).toMatchObject({ actual: range.at_least });
        expect(judged!.record).not.toHaveProperty("actual_range");
      } else {
        expect(judged!.record).toMatchObject({ actual_range: range });
        expect(judged!.record).not.toHaveProperty("actual");
      }
      if (outcome === "unjudged" && range.at_most === null) expect((judged!.record as { reason: string }).reason).toMatch(/^the events of post@4 are not whole \(no-requests\): /);
      expect(judged!.eventsKey).toBe("writes");
    }));

  it("breaks on a reading that is not whole when every count it allows breaks, and otherwise names the gap word that left the claim unjudged", async () => {
    const pattern = "nothing was written";
    const pending: EventsGap = { gap: "jobs-pending", job_ids: ["3f2a9c4100000000"] };
    const [judged] = await evaluateClaims([onWrites("equal", { literal: 0 })], inputsWith(readingSide({ at_least: 1, at_most: null }, pending), pattern));
    expect(judged!.record).toEqual({
      actual_range: { at_least: 1, at_most: null },
      actual_from: LABEL,
      compare: "equal",
      expected: 0,
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "broken",
    });
    const [open] = await evaluateClaims([onWrites("equal", { literal: 0 })], inputsWith(readingSide({ at_least: 0, at_most: null }, pending), pattern));
    expect(open!.record).toEqual({
      actual_range: { at_least: 0, at_most: null },
      actual_from: LABEL,
      compare: "equal",
      expected: 0,
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "unjudged",
      reason: "the events of post@4 are not whole (jobs-pending): job 3f2a9c4100000000 was enqueued and has not performed, so the count is at least 0, with no upper bound, and equal 0 is not known",
    });
    const [unread] = await evaluateClaims(
      [onWrites("equal", { literal: 0 })],
      inputsWith({ label: LABEL, of: "post@4", reading: { range: { at_least: 0, at_most: null }, whole: false, open: [{ gap: "world-unread" }], maybe: NO_MAYBE } }, pattern),
    );
    expect(unread!.record).toMatchObject({
      outcome: "unjudged",
      reason: expect.stringMatching(/^the events of post@4 were not read \(world-unread\): /),
    });
  });

  it("compares with a number the line captures, and breaks on one that is not a number", async () => {
    const pattern = "the rows were written {n:int} times";
    const [held] = await evaluateClaims([onWrites("equal", "n")], inputsWith(readingSide({ at_least: 2, at_most: 2 }), pattern, { n: 2 }));
    expect(held!.record).toMatchObject({ actual: 2, expected: 2, expected_from: "sentence:n", outcome: "held" });
    const [text] = await evaluateClaims([onWrites("equal", "n")], inputsWith(readingSide({ at_least: 2, at_most: 2 }), pattern, { n: "2" }));
    expect(text!.record).toMatchObject({ outcome: "broken", reason: "the expected value sentence:n is a string, and a count of execution events is compared with a number" });
  });

  it("records no count where the step holds no reading, and the reason the reading could not be made", async () => {
    const pattern = "nothing was written";
    const [unjudged] = await evaluateClaims([onWrites("equal", { literal: 0 })], inputsWith({ label: LABEL, unjudged: "post and get both ran earlier in the scenario" }, pattern));
    expect(unjudged!.record).toEqual({
      actual_from: LABEL,
      compare: "equal",
      expected: 0,
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "unjudged",
      reason: "post and get both ran earlier in the scenario",
    });
    expect(unjudged!.eventsKey).toBeUndefined();
    const [broken] = await evaluateClaims([onWrites("equal", { literal: 0 })], inputsWith({ label: LABEL, broken: "table is 7, which is not a string" }, pattern));
    expect(broken!.record).toMatchObject({ outcome: "broken", reason: "table is 7, which is not a string" });
    expect(broken!.record).not.toHaveProperty("actual");
  });

  it("names the claim step's own reading as where the count was measured, whatever the outcome", async () =>
    hegel.testAsync(async (tc) => {
      const range = tc.draw(ranges);
      const [judged] = await evaluateClaims([onWrites("equal", { literal: 0 })], inputsWith(readingSide(range), "nothing was written"));
      const [record] = withMeasured([judged!], { ownRecordId: "step-2", ownChannels: [], fromRecordOf: () => null, channelsOf: () => [], secrets: [] });
      expect(record!.measured).toEqual({ step_record_id: "step-2", channel: "events_read.writes" });
    }));
});
