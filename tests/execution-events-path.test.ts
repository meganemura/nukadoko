import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectWorldEvents, createEventsReader } from "../src/context/events-file.js";
import { tallyInputsOfSlice } from "../src/context/events-read.js";
import { parseEventLine } from "../src/execution-events/format.js";
import { boundingGaps, createPathFold, rangeOn, type PathKey, type StepPath } from "../src/execution-events/path.js";
import { createTraceTally } from "../src/execution-events/tally.js";
import { JOBS, op, PREFIX, render, SPANS, T, traceparent, U, type Op } from "./helpers/event-lines.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: a step's coarse execution path
// (src/execution-events/path.ts): what it counts of each line of a trace,
// that the order lines arrive in changes no count, that its gaps are the
// tally's over the same lines, and the range a count on a path lies in.
// The format's own example is read line by line, as a reader of a path
// would read it. The world's stop folds a step's path over every line of
// its trace, so a line that arrived after the step's record counts as one
// in its slice does.

// The kinds the shared generator does not write: a read, which no path
// keeps, a flag with a gate, an error, and an outgoing call.
type PathOp = Op | readonly ["read"] | readonly ["flag", "on" | "off", "boolean" | "actor" | null] | readonly ["error"] | readonly ["http"];

const pathOp: gs.Generator<PathOp> = gs.oneOf<PathOp>(
  op,
  gs.just<PathOp>(["read"]),
  gs.tuples(gs.sampledFrom(["on", "off"] as const), gs.sampledFrom(["boolean", "actor", null] as const)).map(([side, gate]): PathOp => ["flag", side, gate]),
  gs.just<PathOp>(["error"]),
  gs.just<PathOp>(["http"]),
);

function text(entry: PathOp): string {
  const whole = traceparent(T, SPANS[0]!);
  switch (entry[0]) {
    case "read":
      return JSON.stringify({ trace: whole, kind: "db", table: "rooms", op: "read" });
    case "flag":
      return JSON.stringify({ trace: whole, kind: "flag", name: "quick_reorder", side: entry[1], ...(entry[2] === null ? {} : { gate: entry[2] }) });
    case "error":
      return JSON.stringify({ trace: whole, kind: "error", class: "CacheMiss", handled: true });
    case "http":
      return JSON.stringify({ trace: whole, kind: "http", method: "POST", origin: "https://mail.example.test", path: "/v1/send", status: 202 });
    default:
      return render(entry, T, U, "");
  }
}

function fold(texts: readonly string[], spans: readonly string[], file = { truncated: false, replaced: false }): StepPath {
  const paths = createPathFold({ spans, spansNotKept: 0, processes: "none", processSpans: [] });
  for (const line of texts.map(parseEventLine)) {
    if (line.state === "unreadable") paths.damaged();
    else paths.owned(line);
  }
  return paths.path(file);
}

function shuffled<Item>(tc: hegel.TestCase, items: readonly Item[]): Item[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = tc.draw(gs.integers({ minValue: 0, maxValue: index }));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

const sortedJobs = (open: StepPath["open"]): StepPath["open"] => open.map((gap) => ("job_ids" in gap ? { ...gap, job_ids: [...gap.job_ids].sort() } : gap));

describe("createPathFold", () => {
  it("counts the same in any order the lines arrive, since processes append in write order", () =>
    hegel.test((tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const texts = tc.draw(gs.arrays(pathOp, { maxSize: 12 })).map(text);
      const inOrder = fold(texts, spans);
      const reordered = fold(shuffled(tc, texts), spans);
      expect(reordered.entries).toEqual(inOrder.entries);
      expect(reordered.maybe).toBe(inOrder.maybe);
      expect(sortedJobs(reordered.open)).toEqual(sortedJobs(inOrder.open));
      const asSet = (requests: StepPath["requests"]): string[] => requests.map((request) => JSON.stringify(request)).sort();
      expect(asSet(reordered.requests)).toEqual(asSet(inOrder.requests));
    }));

  it("has the gaps the tally finds over the same lines", () =>
    hegel.test((tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const texts = tc.draw(gs.arrays(pathOp, { maxSize: 12 })).map(text);
      const file = { truncated: tc.draw(gs.booleans()), replaced: tc.draw(gs.booleans()) };
      const tally = createTraceTally({ spans, spansNotKept: 0, processes: "none", processSpans: [] });
      for (const line of texts.map(parseEventLine)) {
        if (line.state === "unreadable") tally.damaged();
        else tally.owned(line);
      }
      expect(fold(texts, spans, file).open).toEqual(tally.reading(file).open);
    }));

  it("counts each line once: a request in requests, a write, job, flag, error, outgoing call, or writer's own kind in its entry, and a line that may be any line in maybe", () =>
    hegel.test((tc) => {
      const ops = tc.draw(gs.arrays(pathOp, { maxSize: 12 }));
      const found = fold(ops.map(text), SPANS);
      const count = (...kinds: string[]): number => ops.filter((entry) => kinds.includes(entry[0])).length;
      const entry = (key: Record<string, unknown>): number => found.entries.find((candidate) => Object.entries(key).every(([field, value]) => (candidate as Record<string, unknown>)[field] === value))?.count ?? 0;
      expect(found.requests).toHaveLength(count("request"));
      expect(entry({ kind: "db", table: "scores", op: "insert" })).toBe(count("db", "write"));
      expect(found.entries.some((candidate) => candidate.kind === "db" && candidate.op === "read")).toBe(false);
      expect(entry({ kind: "job", phase: "enqueue" })).toBe(count("enqueue"));
      expect(entry({ kind: "job", phase: "perform" })).toBe(count("perform"));
      expect(entry({ kind: "flag", side: "on" }) + entry({ kind: "flag", side: "off" })).toBe(count("flag"));
      expect(entry({ kind: "error" })).toBe(count("error"));
      expect(entry({ kind: "http" })).toBe(count("http"));
      // A writer's own kind no one names a field of counts by its kind
      // alone, whatever its fields hold.
      expect(found.entries.filter((candidate) => candidate.kind === "x_cache")).toEqual(count("extension") === 0 ? [] : [{ kind: "x_cache", count: count("extension") }]);
      expect(found.maybe).toBe(count("undefined-kind", "unknown-version", "damaged"));
      expect(found.entries.reduce((total, candidate) => total + candidate.count, 0)).toBe(count("db", "write", "enqueue", "perform", "flag", "error", "http", "extension"));
    }));

  it("lists the requests the step stamped in the order it sent them, then the rest as they arrived", () => {
    const line = (span: string | null, status: number): string =>
      JSON.stringify({ trace: span === null ? T : traceparent(T, span), kind: "request", method: "GET", route: "/rooms/:id", status });
    const found = fold([line(null, 500), line(SPANS[2]!, 202), line("2222222222222222", 404), line(SPANS[0]!, 200), line(SPANS[1]!, 201)], SPANS);
    expect(found.requests.map((request) => request.status)).toEqual([200, 201, 202, 500, 404]);
  });

  it("names each flag's gates in the format's order, then a word it does not define, then none named", () => {
    const flag = (gate?: string): string => JSON.stringify({ trace: traceparent(T, SPANS[0]!), kind: "flag", name: "quick_reorder", side: "on", ...(gate === undefined ? {} : { gate }) });
    const found = fold([flag(), flag("x_rule"), flag("percentage"), flag("boolean"), flag("boolean")], [SPANS[0]!]);
    expect(found.entries).toEqual([{ kind: "flag", name: "quick_reorder", side: "on", count: 5, gates: ["boolean", "percentage", "x_rule", null] }]);
  });
});

/** The first block of `jsonl` in the format's own document: its example. */
function documentExample(): { readonly placed: string[]; readonly refused: string } {
  const blocks = [...readFileSync(path.join(repoRoot, "docs/execution-events.md"), "utf8").matchAll(/```jsonl\n([\s\S]*?)```/g)].map((match) => match[1]!.trim().split("\n"));
  return { placed: blocks[0]!, refused: blocks[1]![0]! };
}

describe("a writer's own kind", () => {
  // A decision line as an application writes it: the named field, one it
  // does not name (an id that differs on every line), and a nested value.
  const decision = (features: readonly string[], plan: string, id: number): string =>
    JSON.stringify({ trace: traceparent(T, SPANS[0]!), kind: "x_decision", x_id: `d${id}`, x_result: { features, reason: `plan:${plan}` } });
  const own = (fields: readonly string[]) => ({ fields: new Map([["x_decision", fields]]), redact: (value: unknown) => value });
  const foldOwn = (texts: readonly string[], fields: readonly string[]): StepPath => {
    const paths = createPathFold({ spans: SPANS, spansNotKept: 0, processes: "none", processSpans: [] }, own(fields));
    for (const line of texts.map(parseEventLine)) if (line.state !== "unreadable") paths.owned(line);
    return paths.path({ truncated: false, replaced: false });
  };
  const featureSets = gs.sampledFrom([["projects"], ["projects", "sso"], ["projects", "sso", "audit_log"]] as const);

  it("counts each line once, by the values of the fields named and of no other", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.tuples(featureSets, gs.sampledFrom(["team", "pro"] as const)), { maxSize: 10 }));
      const texts = lines.map(([features, plan], index) => decision(features, plan, index));
      const found = foldOwn(texts, ["x_result.features"]).entries;
      const expected = new Map<string, number>();
      for (const [features] of lines) expected.set(JSON.stringify(features), (expected.get(JSON.stringify(features)) ?? 0) + 1);
      expect(found.map((entry) => [JSON.stringify((entry as Record<string, unknown>)["x_result.features"]), entry.count]).sort()).toEqual([...expected].sort());
      expect(found.every((entry) => Object.keys(entry).sort().join() === "count,kind,x_result.features")).toBe(true);
    }));

  it("splits an entry by every field named, in any order the fields are named", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.tuples(featureSets, gs.sampledFrom(["team", "pro"] as const)), { maxSize: 10 }));
      const texts = lines.map(([features, plan], index) => decision(features, plan, index));
      const one = foldOwn(texts, ["x_result.features", "x_result.reason"]).entries;
      expect(foldOwn(shuffled(tc, texts), ["x_result.reason", "x_result.features"]).entries).toEqual(one);
      expect(one).toHaveLength(new Set(lines.map((line) => JSON.stringify(line))).size);
    }));

  it("keeps a field the line lacks as null, and redacts what it keeps", () => {
    const paths = createPathFold({ spans: SPANS, spansNotKept: 0, processes: "none", processSpans: [] }, { fields: new Map([["x_decision", ["x_result.features", "x_subject"]]]), redact: (value) => (value === "secret" ? "[redacted]" : value) });
    paths.owned(parseEventLine(JSON.stringify({ trace: traceparent(T, SPANS[0]!), kind: "x_decision", x_result: { features: "secret" } })) as never);
    expect(paths.path({ truncated: false, replaced: false }).entries).toEqual([{ kind: "x_decision", "x_result.features": "[redacted]", x_subject: null, count: 1 }]);
  });
});

describe("a path of the format's own example", () => {
  const spans = ["00f067aa0ba902b7"];
  const scores = { kind: "db", table: "scores", op: "insert" } as const satisfies PathKey;
  const perform = { kind: "job", name: "ScoreRecalcJob", phase: "perform" } as const satisfies PathKey;
  const request = { kind: "request", method: "POST", route: "/rooms/:room_id/scores", status: 303 } as const satisfies PathKey;

  it("holds the writes, the job's two phases, the flag, and the request, and leaves out the read and the transaction", () => {
    const placed = fold(documentExample().placed, spans);
    expect(placed).toEqual({
      requests: [{ method: "POST", route: "/rooms/:room_id/scores", status: 303 }],
      entries: [
        { kind: "db", table: "rankings", op: "update", count: 1 },
        { kind: "db", table: "scores", op: "insert", count: 1 },
        { kind: "job", name: "ScoreRecalcJob", phase: "enqueue", count: 1 },
        { kind: "job", name: "ScoreRecalcJob", phase: "perform", count: 1 },
        { kind: "flag", name: "score_input_slider", side: "off", count: 1, gates: ["boolean"] },
      ],
      maybe: 0,
      open: [],
    });
    expect(rangeOn(placed, scores)).toEqual({ at_least: 1, at_most: 1 });
    expect(rangeOn(placed, { kind: "db", table: "audit_log", op: "insert" })).toEqual({ at_least: 0, at_most: 0 });
  });

  it("leaves the job's writes open after line 6, and the request exact, since every request line is in", () => {
    const afterSix = fold(documentExample().placed.slice(0, 6), spans);
    expect(afterSix.open).toEqual([{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }]);
    expect(rangeOn(afterSix, perform)).toEqual({ at_least: 0, at_most: null });
    expect(rangeOn(afterSix, scores)).toEqual({ at_least: 1, at_most: null });
    expect(rangeOn(afterSix, request)).toEqual({ at_least: 1, at_most: 1 });
  });

  it("holds one request and nothing else for the refused score", () => {
    const refused = fold([documentExample().refused], ["b7ad6b7169203331"]);
    expect(refused).toEqual({ requests: [{ method: "POST", route: "/rooms/:room_id/scores", status: 422 }], entries: [], maybe: 0, open: [] });
    expect(rangeOn(refused, scores)).toEqual({ at_least: 0, at_most: 0 });
  });
});

describe("rangeOn", () => {
  it("bounds a count by the lines that may be any line on a whole path, leaves it unbounded under a gap, and clips a flag to seen or not", () =>
    hegel.test((tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const ops = tc.draw(gs.arrays(pathOp, { maxSize: 12 }));
      const found = fold(ops.map(text), spans);
      const gaps = boundingGaps(found);
      const count = (...kinds: string[]): number => ops.filter((entry) => kinds.includes(entry[0])).length;
      const keys: readonly (readonly [PathKey, number])[] = [
        [{ kind: "db", table: "scores", op: "insert" }, count("db", "write")],
        [{ kind: "job", name: "ScoreRecalcJob", phase: "perform" }, count("perform")],
        [{ kind: "request", method: "GET", route: "/rooms/:id", status: 200 }, count("request")],
      ];
      for (const [key, lines] of keys) {
        const range = rangeOn(found, key);
        expect(range.at_least).toBe(lines);
        const bounded = gaps.length === 0 || (key.kind === "request" && gaps.every(({ gap }) => gap === "jobs-pending"));
        expect(range.at_most).toBe(bounded ? lines + found.maybe : null);
      }
      const flag = rangeOn(found, { kind: "flag", name: "quick_reorder", side: "on" });
      expect(flag.at_least).toBe(ops.some((entry) => entry[0] === "flag" && entry[1] === "on") ? 1 : 0);
      expect(flag.at_most).toBe(gaps.length === 0 && found.maybe === 0 ? flag.at_least : 1);
    }));

  it("reads a step that sent nothing and has no line as an exact empty path, and one that sent nothing and has a line as open", () => {
    const empty = fold([], []);
    expect(empty.open).toEqual([{ gap: "no-requests" }]);
    expect(boundingGaps(empty)).toEqual([]);
    expect(rangeOn(empty, { kind: "db", table: "scores", op: "insert" })).toEqual({ at_least: 0, at_most: 0 });
    const lined = fold([text(["enqueue", 0]), text(["perform", 0])], []);
    expect(boundingGaps(lined)).toEqual([{ gap: "no-requests" }]);
    expect(rangeOn(lined, { kind: "job", name: "ScoreRecalcJob", phase: "perform" })).toEqual({ at_least: 1, at_most: null });
  });

  it("counts a job's lines whatever job id they carry", () => {
    const found = fold([text(["enqueue", 0]), text(["enqueue", 1]), text(["perform", 1])], [SPANS[0]!]);
    expect(found.entries.find((entry) => entry.kind === "job" && entry.phase === "enqueue")?.count).toBe(JOBS.length);
  });
});

describe("the world's stop", () => {
  const withDir = async <Result>(run: (dir: string) => Promise<Result>): Promise<Result> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-path-test-"));
    try {
      return await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const fileLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : []);

  it("gives a step the path of every line of its trace, its slice and its late lines alike, wherever another trace's lines fall", () =>
    hegel.testAsync(async (tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const own = tc.draw(gs.arrays(pathOp, { maxSize: 10 })).map(text);
      const mixed = [...own];
      for (const other of tc.draw(gs.arrays(op, { maxSize: 6 })).map((entry) => render(entry, U, T, ""))) mixed.splice(tc.draw(gs.integers({ minValue: 0, maxValue: mixed.length })), 0, other);
      const before = tc.draw(gs.integers({ minValue: 0, maxValue: mixed.length }));
      await withDir(async (dir) => {
        const file = path.join(dir, "events.jsonl");
        writeFileSync(file, "");
        const reader = createEventsReader(file, PREFIX, []);
        appendFileSync(file, mixed.slice(0, before).map((line) => `${line}\n`).join(""));
        const stepDir = path.join(dir, "step");
        const slice = await reader.slice(stepDir, { traceId: T, stamped: spans.length, lastStampAt: undefined, spans, spansNotKept: 0, processes: "none", processSpans: [] });
        appendFileSync(file, mixed.slice(before).map((line) => `${line}\n`).join(""));
        const { paths } = collectWorldEvents(file, PREFIX, [{ traceId: T, lines: slice.lines, dir: stepDir, inputs: tallyInputsOfSlice(slice), replaced: false }], [], path.join(dir, "world.jsonl"));
        expect(paths.get(T)).toEqual(fold(own, spans));
        // A damaged line is kept only in the world's copy, so the step's
        // own two files give the same path when no line of it is damaged.
        const kept = [...fileLines(path.join(stepDir, "events.jsonl")), ...fileLines(path.join(stepDir, "events-late.jsonl"))];
        if (own.every((line) => parseEventLine(line).state !== "unreadable")) expect(fold(kept, spans)).toEqual(paths.get(T));
      });
    }));
});
