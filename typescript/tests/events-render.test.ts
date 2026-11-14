import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { COUNT_COMPARES, describeRange } from "../src/execution-events/count.js";
import type { ClaimComparisonRecord } from "../src/record/types.js";
import { brokenClaimsMessage, claimLine } from "../src/report/summary/claim-line.js";

// Responsibility: how a claim on a count of execution events reads in one
// line (src/report/summary/claim-line.ts), the words the run summary, the
// step's failure message, and each report share: a count that is one
// number shows as the number, and one that is a range shows as its range,
// before the source, and the lines the count counted follow the outcome,
// so a reader sees what the claim compared, and what made the count,
// without opening the record.

const FROM = "events:post@8 count db where table scores, op insert, committed true";

function rangeRecord(range: { at_least: number; at_most: number | null }, compare: (typeof COUNT_COMPARES)[number], expected: number): ClaimComparisonRecord {
  return {
    actual_range: range,
    actual_from: FROM,
    compare,
    expected,
    expected_from: "literal:once",
    expected_text: "once",
    outcome: "unjudged",
    reason: "the events of post@8 are not whole (jobs-pending)",
    measured: { step_record_id: "step-1", channel: "events_read.inserts" },
  } as ClaimComparisonRecord;
}

describe("the claim line of a count of execution events", () => {
  it("names a range the count is not one number of, before its source, under every compare", () =>
    hegel.test((tc) => {
      const atLeast = tc.draw(gs.integers({ minValue: 0, maxValue: 50 }));
      const width = tc.draw(gs.integers({ minValue: 1, maxValue: 50 }));
      const bounded = tc.draw(gs.booleans());
      const range = { at_least: atLeast, at_most: bounded ? atLeast + width : null };
      const compare = tc.draw(gs.sampledFrom([...COUNT_COMPARES]));
      const expected = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
      const record = rangeRecord(range, compare, expected);
      expect(claimLine(record)).toBe(`${describeRange(range)} (${FROM}) ${compare} ${expected} (literal:once) unjudged: the events of post@8 are not whole (jobs-pending)`);
      expect(brokenClaimsMessage([record])).toBe(`claim unjudged: ${describeRange(range)} (${FROM}) ${compare} ${expected} (literal:once): the events of post@8 are not whole (jobs-pending)`);
    }));

  it("names the lines the count counted after its outcome and its reason, under every outcome, and nothing when it counted none", () => {
    const WRITES = "events:get@4 count db where op in [insert, update, delete, other], committed true";
    const events = [{ kind: "db" as const, fields: { op: "insert", table: "events" }, lines: 1 }];
    const nothing = { actual: 1, counted: events, actual_from: WRITES, compare: "equal", expected: 0, expected_from: "literal:nothing", expected_text: "nothing", outcome: "broken" } as ClaimComparisonRecord;
    expect(claimLine(nothing)).toBe(`1 (${WRITES}) equal 0 (literal:nothing) broken; counted 1 line: db insert into events`);
    expect(brokenClaimsMessage([nothing])).toBe(`claim broken: 1 (${WRITES}) equal 0 (literal:nothing); counted 1 line: db insert into events`);
    const scores = [{ kind: "db" as const, fields: { op: "insert", table: "scores" }, lines: 1 }];
    const once = { ...rangeRecord({ at_least: 1, at_most: 1 }, "equal", 1), actual_range: undefined, actual: 1, counted: scores, outcome: "held", reason: undefined } as unknown as ClaimComparisonRecord;
    expect(claimLine(once)).toBe(`1 (${FROM}) equal 1 (literal:once) held; counted 1 line: db insert into scores`);
    expect(brokenClaimsMessage([once])).toBe("");
    const open = { ...rangeRecord({ at_least: 1, at_most: null }, "equal", 1), counted: scores };
    expect(claimLine(open)).toBe(`at least 1, with no upper bound (${FROM}) equal 1 (literal:once) unjudged: the events of post@8 are not whole (jobs-pending); counted 1 line: db insert into scores`);
    expect(claimLine({ ...nothing, actual: 0, counted: [], outcome: "held" })).toBe(`0 (${WRITES}) equal 0 (literal:nothing) held`);
  });

  it("names one number as the number", () => {
    const { actual_range: _range, ...rest } = rangeRecord({ at_least: 2, at_most: 2 }, "equal", 1);
    expect(claimLine({ ...rest, actual: 2, outcome: "broken", reason: undefined } as unknown as ClaimComparisonRecord)).toBe(`2 (${FROM}) equal 1 (literal:once) broken`);
  });
});
