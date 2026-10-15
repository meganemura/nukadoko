import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { deepEqual } from "../src/draft/index.js";
import { categorizeArgs } from "../src/harvest/categorize-args.js";
import { defineStep, type Step } from "../src/step/define-step.js";
import type { StepRecordOk } from "../src/record/types.js";

// Responsibility: unit tests for src/harvest/categorize-args.ts's own
// branches that harvest.test.ts's fixture-driven cases never reach — every
// `Step`/`StepRecord` here is built directly, the same in-memory approach
// tests/validate-from.test.ts already uses, so a `used` entry can be pointed
// at a producer record that is missing, failed, or returned something that
// isn't even an object, without a real `nuka do` run to manufacture one.

function makeRecord(id: string, step: string, args: unknown, overrides: Partial<StepRecordOk> = {}): StepRecordOk {
  return {
    step_record_id: id,
    step,
    kind: "do",
    args,
    environment: "default",
    session: null,
    scenario_record_id: null,
    run_id: null,
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: `.nukadoko/records/steps/${id}`, screenshots: [] },
    observed: { http_reads: 0, http_writes: 0 },
    mutates: true,
    status: "ok",
    result: {},
    ...overrides,
  };
}

describe("deepEqual", () => {
  it("compares two arrays of equal length element by element", () => {
    expect(deepEqual([1, "a", true], [1, "a", true])).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });

  it("treats two arrays of different length as unequal without inspecting elements", () => {
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
  });

  it("treats two plain records with a different number of keys as unequal without comparing values", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("compares nested arrays inside plain records", () => {
    expect(deepEqual({ rows: [["a", "b"]] }, { rows: [["a", "b"]] })).toBe(true);
    expect(deepEqual({ rows: [["a", "b"]] }, { rows: [["a", "c"]] })).toBe(false);
  });
});

describe("categorizeArgs: a step whose args schema is not an object", () => {
  it("has nothing to categorize at all", () => {
    const step = defineStep({
      description: "d",
      args: z.string(),
      returns: z.object({}),
      run: () => ({}),
    });
    const record = makeRecord("r-1", "bare-thing", "just a string");

    const result = categorizeArgs(step, record, new Set(), new Set(), new Map(), new Map());

    expect(result).toEqual({ chainKeys: new Set(), chainOutsideList: new Map(), unfillable: [], omittedMeasured: [] });
  });
});

describe("categorizeArgs: a chain candidate that used cites but cannot confirm", () => {
  it("does not confirm a chain when the cited producer record is missing entirely", () => {
    const upstream = defineStep({
      description: "producer",
      args: z.object({}),
      returns: z.object({ id: z.string() }),
      run: () => ({ id: "u1" }),
    });
    const consumer = defineStep({
      description: "consumer",
      args: z.object({ upstreamId: z.string() }),
      returns: z.object({}),
      from: { upstreamId: [upstream, "id"] },
      run: () => ({}),
    });
    const record = makeRecord("r-1", "consumer", { upstreamId: "u1" }, {
      used: [{ step_record_id: "missing-1", step: "producer" }],
    });
    const harvestedIds = new Set(["missing-1"]);
    const recordsById = new Map<string, StepRecordOk>();
    const stepNameOf = new Map<Step, string>([[upstream, "producer"]]);

    const result = categorizeArgs(consumer, record, new Set(), harvestedIds, recordsById, stepNameOf);

    expect(result.chainKeys.size).toBe(0);
    expect(result.chainOutsideList.size).toBe(0);
    // Neither confirmed nor "outside" (its id really is among the given
    // ones) — it falls to the attachment bucket, and a plain string value
    // becomes a docstring.
    expect(result.attachment).toEqual({ kind: "docstring", key: "upstreamId", value: "u1" });
  });

  it("does not confirm a chain when the cited producer's own result isn't an object", () => {
    const upstream = defineStep({
      description: "producer",
      args: z.object({}),
      returns: z.string(),
      run: () => "u1",
    });
    const consumer = defineStep({
      description: "consumer",
      args: z.object({ upstreamId: z.string() }),
      returns: z.object({}),
      from: { upstreamId: [upstream, "id"] },
      run: () => ({}),
    });
    const producerRecord = makeRecord("prod-1", "producer", {}, { result: "u1" });
    const record = makeRecord("r-1", "consumer", { upstreamId: "u1" }, {
      used: [{ step_record_id: "prod-1", step: "producer" }],
    });
    const harvestedIds = new Set(["prod-1"]);
    const recordsById = new Map<string, StepRecordOk>([["prod-1", producerRecord]]);
    const stepNameOf = new Map<Step, string>([[upstream, "producer"]]);

    const result = categorizeArgs(consumer, record, new Set(), harvestedIds, recordsById, stepNameOf);

    expect(result.chainKeys.size).toBe(0);
    expect(result.attachment).toEqual({ kind: "docstring", key: "upstreamId", value: "u1" });
  });
});

describe("categorizeArgs: a key with several candidate producers", () => {
  it("confirms the chain from whichever candidate the used entry actually names, skipping the ones that don't match", () => {
    const stepA = defineStep({
      description: "producer A",
      args: z.object({}),
      returns: z.object({ a: z.string() }),
      run: () => ({ a: "from-a" }),
    });
    const stepB = defineStep({
      description: "producer B",
      args: z.object({}),
      returns: z.object({ b: z.string() }),
      run: () => ({ b: "from-b" }),
    });
    const consumer = defineStep({
      description: "consumer",
      args: z.object({ key: z.string() }),
      returns: z.object({}),
      from: { key: [[stepA, "a"], [stepB, "b"]] },
      run: () => ({}),
    });
    const producerRecord = makeRecord("prod-b", "producer-b", {}, { result: { b: "from-b" } });
    const record = makeRecord("r-1", "consumer", { key: "from-b" }, {
      used: [{ step_record_id: "prod-b", step: "producer-b" }],
    });
    const harvestedIds = new Set(["prod-b"]);
    const recordsById = new Map<string, StepRecordOk>([["prod-b", producerRecord]]);
    const stepNameOf = new Map<Step, string>([
      [stepA, "producer-a"],
      [stepB, "producer-b"],
    ]);

    const result = categorizeArgs(consumer, record, new Set(), harvestedIds, recordsById, stepNameOf);

    expect(result.chainKeys.has("key")).toBe(true);
    expect(result.attachment).toBeUndefined();
    expect(result.unfillable).toEqual([]);
  });
});

describe("categorizeArgs: a used entry unrelated to the key being categorized", () => {
  it("skips a used entry whose step is not one of this key's own from candidates", () => {
    const upstream = defineStep({
      description: "producer",
      args: z.object({}),
      returns: z.object({ id: z.string() }),
      run: () => ({ id: "u1" }),
    });
    const consumer = defineStep({
      description: "consumer",
      args: z.object({ upstreamId: z.string() }),
      returns: z.object({}),
      from: { upstreamId: [upstream, "id"] },
      run: () => ({}),
    });
    const producerRecord = makeRecord("prod-1", "producer", {}, { result: { id: "u1" } });
    const record = makeRecord("r-1", "consumer", { upstreamId: "u1" }, {
      // The first entry names a step this key's own `from` never lists at
      // all (unrelated `ctx.resultOf` provenance, or a different key's own
      // chain) — categorizeArgs must skip it and still confirm from the
      // second, genuine entry.
      used: [
        { step_record_id: "unrelated-1", step: "totally-other-step" },
        { step_record_id: "prod-1", step: "producer" },
      ],
    });
    const harvestedIds = new Set(["unrelated-1", "prod-1"]);
    const recordsById = new Map<string, StepRecordOk>([["prod-1", producerRecord]]);
    const stepNameOf = new Map<Step, string>([[upstream, "producer"]]);

    const result = categorizeArgs(consumer, record, new Set(), harvestedIds, recordsById, stepNameOf);

    expect(result.chainKeys.has("upstreamId")).toBe(true);
  });
});

describe("categorizeArgs: more than one required key left with nothing to fill it", () => {
  it("reports every one of them as unfillable, not just the first", () => {
    const step = defineStep({
      description: "two required keys, neither captured nor chained",
      args: z.object({ a: z.string(), b: z.number() }),
      returns: z.object({}),
      run: () => ({}),
    });
    const record = makeRecord("r-1", "two-keys", { a: "x", b: 2 });

    const result = categorizeArgs(step, record, new Set(), new Set(), new Map(), new Map());

    expect(result.attachment).toBeUndefined();
    expect(result.unfillable).toEqual(
      expect.arrayContaining([
        { key: "a", value: "x" },
        { key: "b", value: 2 },
      ]),
    );
    expect(result.unfillable).toHaveLength(2);
  });
});

describe("categorizeArgs: a measured optional key", () => {
  it("keeps a measured optional value exactly when the schema would not reproduce it", () =>
    hegel.test((tc) => {
      const limit = tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 }));
      const sort = tc.draw(gs.text({ maxSize: 40 }));
      const includeLimit = tc.draw(gs.booleans());
      const step = defineStep({
        description: "search",
        args: z.object({
          query: z.string(),
          limit: z.number().optional(),
          sort: z.string().default("relevance"),
        }),
        returns: z.object({}),
        run: () => ({}),
      });
      const args: Record<string, unknown> = { query: "cat", sort };
      if (includeLimit) {
        args.limit = limit;
      }
      const result = categorizeArgs(step, makeRecord("r-1", "search", args), new Set(["query"]), new Set(), new Map(), new Map());

      if (includeLimit) {
        expect(result.omittedMeasured).toContainEqual({ key: "limit", value: limit });
      } else {
        expect(result.omittedMeasured.find((entry) => entry.key === "limit")).toBeUndefined();
      }
      if (sort === "relevance") {
        expect(result.omittedMeasured.find((entry) => entry.key === "sort")).toBeUndefined();
      } else {
        expect(result.omittedMeasured).toContainEqual({ key: "sort", value: sort });
      }
      expect(result.unfillable).toEqual([]);
      expect(result.attachment).toBeUndefined();
    }));

  it("does not inline an optional key a confirmed chain already supplied", () => {
    const upstream = defineStep({
      description: "producer",
      args: z.object({}),
      returns: z.object({ limit: z.number() }),
      run: () => ({ limit: 3 }),
    });
    const consumer = defineStep({
      description: "consumer",
      pattern: "I search for {query:string}",
      args: z.object({ query: z.string(), limit: z.number().optional() }),
      returns: z.object({}),
      from: { limit: [upstream, "limit"] },
      run: () => ({}),
    });
    const producerRecord = makeRecord("prod-1", "producer", {}, { result: { limit: 3 } });
    const record = makeRecord("r-1", "consumer", { query: "cat", limit: 3 }, {
      used: [{ step_record_id: "prod-1", step: "producer" }],
    });
    const result = categorizeArgs(
      consumer,
      record,
      new Set(["query"]),
      new Set(["prod-1"]),
      new Map([["prod-1", producerRecord]]),
      new Map([[upstream, "producer"]]),
    );

    expect(result.chainKeys.has("limit")).toBe(true);
    expect(result.omittedMeasured).toEqual([]);
  });
});
