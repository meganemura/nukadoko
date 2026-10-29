import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { ClaimComparisonRecord, ClaimEachRecord, ClaimItemDeclaration } from "../src/record/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { holdsNumber, recordedChannels, withMeasured, type ChannelText, type MeasuredContext } from "../src/run/measured.js";
import { expectedOriginOf, type ExpectedOrigin, type JudgedClaim } from "../src/step/evaluate-claims.js";

// Responsibility: which recorded channel holds each side of a claim
// (docs/spec.md "Claims"): an expected value an earlier step returned or
// `observe` read is looked for the same way as the actual value, skipping
// the channel the actual value matched, and a value the feature states is
// not looked for at all.

const OWN = "step-own";
const PRODUCER = "step-producer";

const channels: Record<string, readonly ChannelText[]> = {
  [OWN]: [{ channel: "observed.processes[0].stdout", text: "v1" }],
  [PRODUCER]: [
    { channel: "observed.processes[0].exit_code", number: 0 },
    { channel: "observed.processes[0].stdout", text: "v1" },
    { channel: "observed.processes[1].stdout", text: "v1" },
  ],
};

const context: MeasuredContext = {
  ownRecordId: OWN,
  ownChannels: channels[OWN]!,
  fromRecordOf: (key) => (key === "unfilled" ? null : PRODUCER),
  channelsOf: (id) => channels[id] ?? [],
  secrets: [],
};

function comparison(expected: unknown, outcome: ClaimComparisonRecord["outcome"] = "held"): ClaimComparisonRecord {
  return { actual: 0, actual_from: "from:produce@3.exitCode", compare: "equal", expected, expected_from: "from:produce@3.wanted", expected_text: null, outcome };
}

function judged(record: ClaimComparisonRecord | ClaimEachRecord, rawActual: unknown, fromKey: string | null, expectedOrigins: readonly ExpectedOrigin[]): JudgedClaim {
  return { record, rawActual, fromKey, expectedOrigins };
}

describe("a record with a channel whose content is unknown", () => {
  it("names no channel for a value read out of a body the record cut, though the status holds the same number", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-measured-"));
    try {
      const line = { status: 200, response_body: { text: '{"code":200,"pad":"ppp', bytes: 60020, truncated: true } };
      writeFileSync(path.join(dir, "http.jsonl"), `${JSON.stringify(line)}\n`);
      const recorded = recordedChannels({ observed: {} as never, dir, http: "http.jsonl" });
      expect(recorded).toEqual([
        { channel: "http.jsonl[0].status", number: 200 },
        { channel: "http.jsonl[0].response_body", unknown: true },
      ]);
      const [claim] = withMeasured([judged(comparison(200), 200, "code", [])], { ...context, channelsOf: () => recorded });
      expect(claim).toMatchObject({ measured: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names no channel for any value while one channel of the record is unknown", () =>
    hegel.test((tc) => {
      const value = tc.draw(gs.oneOf<unknown>(gs.integers({ minValue: -5, maxValue: 5 }), gs.text({ maxSize: 4 })));
      const known: ChannelText[] = [typeof value === "number" ? { channel: "observed.processes[0].exit_code", number: value } : { channel: "observed.processes[0].stdout", text: value as string }];
      const unknown: ChannelText = { channel: tc.draw(gs.sampledFrom(["observed.processes[0].stderr", "http.jsonl[0].response_body", "observed.files[0].content"])), unknown: true };
      const [claim] = withMeasured([judged(comparison(value), value, "got", [])], { ...context, channelsOf: () => [...known, unknown] });
      expect(claim).toMatchObject({ measured: null });
      const [alone] = withMeasured([judged(comparison(value), value, "got", [])], { ...context, channelsOf: () => known });
      expect(alone).toMatchObject({ measured: { channel: known[0]!.channel } });
    }));
});

describe("a number more than one channel holds", () => {
  const exitedOne = (stdout: string): MeasuredContext => ({
    ...context,
    channelsOf: () => [
      { channel: "observed.processes[0].stdout", text: stdout },
      { channel: "observed.processes[0].exit_code", number: 1 },
    ],
  });

  it("names no channel when the output writes the number too, and the exit code when it does not", () => {
    const [lineNumber] = withMeasured([judged(comparison(1), 1, "violations", [])], exitedOne('{"violations":[{"rule":"bypass","line":1}]}\n'));
    expect(lineNumber).toMatchObject({ measured: null });
    const [exitCode] = withMeasured([judged(comparison(1), 1, "exitCode", [])], exitedOne('{"violations":[{"rule":"bypass","line":12}]}\n'));
    expect(exitCode).toMatchObject({ measured: { step_record_id: PRODUCER, channel: "observed.processes[0].exit_code" } });
  });

  it("names no channel when two exit codes hold the number", () => {
    const [claim] = withMeasured([judged(comparison(0), 0, "exitCode", [])], {
      ...context,
      channelsOf: () => [
        { channel: "observed.processes[0].exit_code", number: 0 },
        { channel: "observed.processes[1].exit_code", number: 0 },
      ],
    });
    expect(claim).toMatchObject({ measured: null });
  });

  it("holdsNumber finds a number written on its own, and never one inside a longer number or a word", () =>
    hegel.test((tc) => {
      const n = tc.draw(gs.integers({ minValue: -50, maxValue: 50 }));
      const before = tc.draw(gs.sampledFrom(["", " ", ":", "[", "(", "line "]));
      const after = tc.draw(gs.sampledFrom(["", " ", ",", "]", "\n", " file"]));
      expect(holdsNumber({ channel: "c", text: `${before}${n}${after}` }, n)).toBe(true);
      const glued = tc.draw(gs.sampledFrom([`${n}7`, `${n}.5`, `v${n}`, `${n}x`, `7${Math.abs(n)}`]));
      expect(holdsNumber({ channel: "c", text: `${before}${glued}${after}` }, n)).toBe(false);
      expect(holdsNumber({ channel: "c", number: n }, n)).toBe(true);
    }));
});

describe("expected_measured", () => {
  it("skips the channel the actual value matched, so a constant equal to it is none, and finds another channel with the same content", () => {
    const [onlyOne] = withMeasured([judged(comparison(0), 0, "exitCode", [{ fromKey: "wanted" }])], {
      ...context,
      channelsOf: () => [{ channel: "observed.processes[0].exit_code", number: 0 }],
    });
    expect(onlyOne).toMatchObject({ measured: { step_record_id: PRODUCER, channel: "observed.processes[0].exit_code" }, expected_measured: null });
    const [another] = withMeasured([judged(comparison("v1"), "v1", "out", [{ fromKey: "wanted" }])], context);
    expect(another).toMatchObject({
      measured: { step_record_id: PRODUCER, channel: "observed.processes[0].stdout" },
      expected_measured: { step_record_id: PRODUCER, channel: "observed.processes[1].stdout" },
    });
  });

  it("looks in the claim step's own record for an expected value observe read", () => {
    const [claim] = withMeasured([judged(comparison("v1"), 7, null, ["observe"])], context);
    expect(claim).toMatchObject({ measured: null, expected_measured: { step_record_id: OWN, channel: "observed.processes[0].stdout" } });
  });

  it("names each declaration of an each in where-then-claims order", () => {
    const declaration = (expected: unknown): ClaimItemDeclaration => ({ compare: "equal", expected, expected_from: "x", expected_text: null });
    const record: ClaimEachRecord = {
      actual_from: "observe:rows",
      each: { where: [declaration("v1")], claims: [declaration("v2"), declaration("v1")], items: 0, selected: 0, results: [] },
      outcome: "broken",
    };
    const [claim] = withMeasured([judged(record, [], null, [null, { fromKey: "version" }, { fromKey: "version" }])], context);
    const each = (claim as ClaimEachRecord).each;
    expect(Object.hasOwn(each.where![0]!, "expected_measured")).toBe(false);
    expect(each.claims[0]).toMatchObject({ expected_measured: null });
    expect(each.claims[1]).toMatchObject({ expected_measured: { step_record_id: PRODUCER, channel: "observed.processes[0].stdout" } });
  });

  it("is present exactly when the expected value has an origin a record can hold and the claim read something", () =>
    hegel.test((tc) => {
      const origin = tc.draw(gs.sampledFrom<ExpectedOrigin>([null, "observe", { fromKey: "wanted" }, { fromKey: "unfilled" }]));
      const outcome = tc.draw(gs.sampledFrom(["held", "broken", "unjudged", "unobserved"] as const));
      const withValue = tc.draw(gs.booleans());
      const record = comparison(0, outcome);
      if (!withValue) delete (record as { expected?: unknown }).expected;
      const [claim] = withMeasured([judged(record, 0, "exitCode", [origin])], context);
      const present = Object.hasOwn(claim!, "expected_measured");
      expect(present).toBe(origin !== null && outcome !== "unobserved");
      // No value, or no record to look in, is no channel.
      if (present && (!withValue || (typeof origin === "object" && origin?.fromKey === "unfilled"))) expect((claim as ClaimComparisonRecord).expected_measured).toBeNull();
    }));
});

describe("expectedOriginOf", () => {
  const fromKeys = new Set(["result", "wanted"]);

  it("names the from key a from value or a from key fills, observe for an observe value, and nothing for the sentence or a literal", () => {
    expect(expectedOriginOf({ actual: "x", compare: "equal", expected: { from: "result.code" } }, fromKeys)).toEqual({ fromKey: "result" });
    expect(expectedOriginOf({ actual: "x", compare: "equal", expected: "wanted" }, fromKeys)).toEqual({ fromKey: "wanted" });
    expect(expectedOriginOf({ actual: "x", compare: "equal", expected: { observe: "title" } }, fromKeys)).toBe("observe");
    expect(expectedOriginOf({ actual: "x", compare: "equal", expected: "code" }, fromKeys)).toBeNull();
    expect(expectedOriginOf({ actual: "x", compare: "equal", expected: { literal: 0 } }, fromKeys)).toBeNull();
  });
});
