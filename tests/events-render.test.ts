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
// before the source, so a reader sees what the claim compared without
// opening the record.

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

  it("names one number as the number", () => {
    const { actual_range: _range, ...rest } = rangeRecord({ at_least: 2, at_most: 2 }, "equal", 1);
    expect(claimLine({ ...rest, actual: 2, outcome: "broken", reason: undefined } as unknown as ClaimComparisonRecord)).toBe(`2 (${FROM}) equal 1 (literal:once) broken`);
  });
});
