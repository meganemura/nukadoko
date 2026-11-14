import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCommitIndex } from "../src/execution-events/commit-state.js";
import { COUNT_COMPARES, compareCount, judgeCount, judgeRange, rangeOf, type CountRange } from "../src/execution-events/count.js";
import { parseEventLine, type ReadableLine } from "../src/execution-events/format.js";
import { describeSelection, matchLine, resolveSelection, selectionProblems, type DeclaredEventSelection, type EventSelection } from "../src/execution-events/selection.js";
import { createKindsSeen, createTraceTally, type MaybeCounts } from "../src/execution-events/tally.js";
import { op, render, SPANS, T, traceparent, TX_IDS, U } from "./helpers/event-lines.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: the judgment of a count over execution events
// (src/execution-events/selection.ts, commit-state.ts, tally.ts, count.ts):
// what a selection names and refuses, what one line says about it, the
// commit state of a write, the counts a trace's lines add up to with
// the groups of the lines each counts, and the range a compare is judged
// on. A compare holds or breaks only when every count in the range gives
// that answer, and gives that answer whenever they all do; the counts of
// a trace, and their groups, do not depend on the order its lines arrive
// in.

const readable = (text: string): ReadableLine => {
  const line = parseEventLine(text);
  if (line.state === "unreadable") throw new Error(`${text} ${line.why}`);
  return line;
};

const line = (fields: Record<string, unknown>): ReadableLine => readable(JSON.stringify({ trace: traceparent(T, SPANS[0]!), ...fields }));

const NO_MAYBE: MaybeCounts = { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, holds_unknown: 0, commit_unknown: 0, unowned: 0 };

describe("EventSelection", () => {
  it("compiles a selection the format can judge, and nothing else", () => {
    const selections: EventSelection[] = [
      { kind: "db", table: "scores", op: "insert", committed: true },
      { kind: "db", op: ["insert", "update", "delete", "other"], committed: true },
      { kind: "db", table: "rooms", op: "read" },
      { kind: "db", committed: false },
      { kind: "request", method: "POST", route: null, status: [200, 303] },
      { kind: "http", status: null },
      { kind: "job", name: "ScoreRecalcJob", phase: "perform" },
      { kind: "flag", name: "score_input_slider", side: "on", gate: "actor" },
      { kind: "error", handled: false },
      { kind: "tx", phase: "rollback" },
    ];
    // @ts-expect-error a field db does not define
    const misspelled: EventSelection = { kind: "db", tabel: "scores", op: "read" };
    // @ts-expect-error a value outside op's enumeration
    const outside: EventSelection = { kind: "db", op: "write", committed: true };
    // @ts-expect-error a write with no commit state
    const unstated: EventSelection = { kind: "db", table: "scores", op: "insert" };
    // @ts-expect-error committed beside a read alone
    const beside: EventSelection = { kind: "db", op: "read", committed: true };
    // @ts-expect-error committed is a db field only
    const elsewhere: EventSelection = { kind: "request", committed: true };
    // @ts-expect-error a list field is not a selection's
    const list: EventSelection = { kind: "request", calls: ["app.rb:1"] };
    // @ts-expect-error a kind the format does not define
    const undefinedKind: EventSelection = { kind: "database" };
    // @ts-expect-error null only where the format makes it a fact
    const nullRows: EventSelection = { kind: "db", rows: null, committed: true };
    // @ts-expect-error a value from the sentence is a declaration's
    const fromSentence: EventSelection = { kind: "db", table: { sentence: "table" }, committed: true };
    const declared: DeclaredEventSelection = { kind: "db", table: { sentence: "table" }, op: [{ sentence: "op" }, "delete"], committed: true };
    expect([misspelled, outside, unstated, beside, elsewhere, list, undefinedKind, nullRows, fromSentence].length).toBe(9);
    for (const selection of [...selections, declared]) expect(selectionProblems(selection, "events.key.count")).toEqual([]);
  });

  it("refuses at run time what does not compile, in words a refusal carries", () => {
    const where = "events.writes.count";
    expect(selectionProblems({ kind: "db", tabel: "scores", op: "read" }, where)).toEqual([
      'events.writes.count names field "tabel", which kind db does not define; the fields it selects by are table, op, rows, committed',
    ]);
    expect(selectionProblems({ kind: "database" }, where)).toEqual([
      'events.writes.count.kind is "database", which the execution events format does not define; its kinds are request, db, tx, job, http, flag, error',
    ]);
    expect(selectionProblems({ kind: "x_cache" }, where)[0]).toMatch(/^events\.writes\.count\.kind is "x_cache", a writer's own kind/);
    expect(selectionProblems({ kind: "db", op: ["insert", "update"] }, where)).toEqual([
      "events.writes.count selects db lines whose op may be a write and does not state committed, so a write that was rolled back would count as written; add committed: true or committed: false",
    ]);
    expect(selectionProblems({ kind: "db", op: ["read"], committed: true }, where)).toEqual([
      "events.writes.count states committed beside op read; a read persists nothing, so leave committed out",
    ]);
    expect(selectionProblems({ kind: "db", op: { sentence: "op" } }, where)).toHaveLength(1);
    expect(selectionProblems({ kind: "db", op: "write", committed: "yes" }, where)).toEqual([
      'events.writes.count.op is "write", which is not one of read, insert, update, delete, other',
      'events.writes.count.committed is "yes", which is not true or false',
    ]);
    expect(selectionProblems({ kind: "request", status: [], method: ["GET", "GET"], calls: [] }, where)).toEqual([
      "events.writes.count.status is an empty list, which matches no line; name at least one value",
      'events.writes.count.method names "GET" twice',
      'events.writes.count names field "calls", which holds a list, and a count selects by fields that hold one value; the fields it selects by are method, route, status',
    ]);
    expect(selectionProblems({ kind: "db", rows: null, table: { sentence: "" }, committed: true }, where)).toEqual([
      "events.writes.count.rows is null, which is not an integer",
      'events.writes.count.table takes a value from the sentence with no capture name; write { sentence: "<capture>" }',
    ]);
    expect(selectionProblems("db", where)[0]).toMatch(/^events\.writes\.count is not an object/);
  });

  it("fills a value from the sentence, and refuses one that does not fit its field", () => {
    const declared: DeclaredEventSelection = { kind: "db", table: { sentence: "table" }, op: [{ sentence: "op" }, "delete"], committed: true };
    expect(resolveSelection(declared, (name) => ({ table: "scores", op: "insert" })[name], "events.k.count")).toEqual({
      selection: { kind: "db", table: "scores", op: ["insert", "delete"], committed: true },
    });
    expect(resolveSelection(declared, (name) => ({ table: 7, op: "write" })[name], "events.k.count")).toEqual({
      problems: [
        'events.k.count.table takes 7 from the sentence\'s capture "table", which is not a string',
        'events.k.count.op takes "write" from the sentence\'s capture "op", which is not one of read, insert, update, delete, other',
      ],
    });
  });

  it("is described in the order the format lists its fields", () => {
    expect(describeSelection({ kind: "db", committed: true, op: ["insert", "update", "delete", "other"] })).toBe("db where op in [insert, update, delete, other], committed true");
    expect(describeSelection({ kind: "db", op: "insert", table: "scores", committed: true })).toBe("db where table scores, op insert, committed true");
    expect(describeSelection({ kind: "request", route: null, method: "POST" })).toBe("request where method POST, route null");
    expect(describeSelection({ kind: "flag", name: "a flag" })).toBe('flag where name "a flag"');
    expect(describeSelection({ kind: "job" })).toBe("job");
  });
});

describe("matchLine", () => {
  const inserts: EventSelection = { kind: "db", table: "scores", op: "insert", committed: true };

  it("answers no on any field that differs, and may match on one it cannot read", () => {
    expect(matchLine(inserts, line({ kind: "db", table: "scores", op: "insert", committed: true }))).toBe("commit-state");
    expect(matchLine({ kind: "db", table: "scores", op: "read" }, line({ kind: "db", table: "scores", op: "read" }))).toBe("yes");
    expect(matchLine(inserts, line({ kind: "db", table: "rooms", op: "insert" }))).toBe("no");
    expect(matchLine(inserts, line({ kind: "request", method: "GET", route: null, status: 200 }))).toBe("no");
    expect(matchLine({ kind: "flag", gate: "actor" }, line({ kind: "flag", name: "f", side: "on" }))).toBe("field_unknown");
    expect(matchLine({ kind: "flag", gate: "actor" }, line({ kind: "flag", name: "f", side: "on", gate: "everyone" }))).toBe("field_unknown");
    expect(matchLine({ kind: "flag", gate: "actor", name: "g" }, line({ kind: "flag", name: "f", side: "on" }))).toBe("no");
    expect(matchLine({ kind: "db", rows: 1, committed: true }, line({ kind: "db", table: "t", op: "update", rows: null }))).toBe("field_unknown");
    expect(matchLine({ kind: "request", route: null }, line({ kind: "request", method: "GET", route: null, status: 404 }))).toBe("yes");
    expect(matchLine({ kind: "request", route: "/rooms" }, line({ kind: "request", method: "GET", route: null, status: 404 }))).toBe("no");
  });

  it("reads a table the writer could not name, and an operation it could not tell, as maybe", () => {
    expect(matchLine(inserts, line({ kind: "db", table: "unknown", op: "insert" }))).toBe("field_unknown");
    expect(matchLine(inserts, line({ kind: "db", table: "scores", op: "other" }))).toBe("field_unknown");
    expect(matchLine({ kind: "db", op: "read" }, line({ kind: "db", table: "scores", op: "other" }))).toBe("no");
    expect(matchLine({ kind: "db", table: "unknown", op: "read" }, line({ kind: "db", table: "unknown", op: "read" }))).toBe("yes");
  });

  it("judges a writer's own kind by nothing, and a kind or a version it does not know as maybe", () => {
    expect(matchLine(inserts, line({ kind: "x_cache", table: "scores" }))).toBe("no");
    expect(matchLine(inserts, line({ kind: "queue" }))).toBe("undefined_kind");
    expect(matchLine({ kind: "request" }, line({ kind: "db", table: "t", op: "read", v: 2 }))).toBe("unknown_version");
  });
});

describe("the commit state of a write", () => {
  function stateOf(lines: readonly Record<string, unknown>[], write: Record<string, unknown>) {
    const index = createCommitIndex();
    for (const fields of lines) index.note(line(fields));
    return index.stateOf(line({ kind: "db", table: "scores", op: "insert", ...write }).object);
  }
  const tx = (id: string, phase: "commit" | "rollback", parent?: string) => ({ kind: "tx", id, phase, ...(parent === undefined ? {} : { parent }) });
  const request = { kind: "request", id: "r1", method: "POST", route: "/s", status: 303 };

  it("follows the parent chain through the transactions to the line around them", () => {
    expect(stateOf([tx("t1", "commit", "r1"), request], { parent: "t1" })).toBe("persisted");
    expect(stateOf([tx("s1", "commit", "t1"), tx("t1", "commit")], { parent: "s1" })).toBe("persisted");
    expect(stateOf([tx("s1", "commit", "t1"), tx("t1", "rollback", "r1"), request], { parent: "s1" })).toBe("not-persisted");
    expect(stateOf([tx("s1", "rollback", "t1"), tx("t1", "commit", "r1"), request], { parent: "s1" })).toBe("not-persisted");
  });

  it("is unknown until every transaction on the chain has its line, unless one rolled back", () => {
    expect(stateOf([], { parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("t1", "commit", "r1")], { parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("s1", "rollback", "t1")], { parent: "s1" })).toBe("not-persisted");
    expect(stateOf([tx("s1", "commit", "t1")], { parent: "s1" })).toBe("unknown");
  });

  it("is unknown on an id two lines carry, a line of a kind or version not known, a cycle, or no transaction", () => {
    expect(stateOf([tx("t1", "commit", "r1"), tx("t1", "rollback", "r1"), request], { parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("s1", "rollback", "t1"), tx("s1", "commit", "t1")], { parent: "s1" })).toBe("unknown");
    expect(stateOf([{ kind: "transaction", id: "t1" }], { parent: "t1" })).toBe("unknown");
    expect(stateOf([{ ...tx("t1", "commit", "r1"), v: 2 }, request], { parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("a", "commit", "b"), tx("b", "commit", "a")], { parent: "a" })).toBe("unknown");
    expect(stateOf([request], { parent: "r1" })).toBe("unknown");
    expect(stateOf([], {})).toBe("unknown");
    expect(stateOf([request], { parent: 7 })).toBe("unknown");
  });

  it("takes the line's own committed, unless a transaction on its chain rolled back or cannot be told", () => {
    expect(stateOf([], { committed: true })).toBe("persisted");
    expect(stateOf([], { committed: false, parent: "job1" })).toBe("not-persisted");
    expect(stateOf([tx("t1", "rollback")], { committed: true, parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("t1", "commit"), tx("t1", "commit")], { committed: true, parent: "t1" })).toBe("unknown");
    expect(stateOf([tx("t1", "commit")], { committed: true, parent: "t1" })).toBe("persisted");
    expect(stateOf([], { committed: "yes" })).toBe("unknown");
  });
});

/** The first block of `jsonl` in the format's own document: its example. */
function documentExample(): string[] {
  const text = readFileSync(path.join(repoRoot, "docs/execution-events.md"), "utf8");
  const block = /```jsonl\n([\s\S]*?)```/.exec(text)![1]!;
  return block.trim().split("\n");
}

describe("createTraceTally's counts", () => {
  const selections: EventSelection[] = [
    { kind: "db", table: "scores", op: "insert", committed: true },
    { kind: "db", op: ["insert", "update", "delete", "other"], committed: true },
    { kind: "db", op: ["insert", "update", "delete", "other"], committed: false },
    { kind: "flag", name: "score_input_slider", side: "off" },
    { kind: "job", phase: "perform" },
    { kind: "request" },
  ];

  function fold(texts: readonly string[], spans: readonly string[], chosen: readonly EventSelection[] = selections) {
    const tally = createTraceTally({ spans, spansNotKept: 0, processes: "none", processSpans: [], selections: chosen });
    for (const text of texts) {
      const parsed = parseEventLine(text);
      if (parsed.state === "unreadable") tally.damaged();
      else tally.owned(parsed);
    }
    return tally;
  }

  it("counts what the format's own example says a reader can tell, line by line", () => {
    const lines = documentExample();
    const spans = ["00f067aa0ba902b7"];
    const afterSix = fold(lines.slice(0, 6), spans).reading({ truncated: false, replaced: false });
    expect(afterSix.whole).toBe(false);
    expect(afterSix.open).toEqual([{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }]);
    const all = fold(lines, spans).reading({ truncated: false, replaced: false });
    expect(all.whole).toBe(true);
    expect(all.counts.map((count) => rangeOf(count, all.whole))).toEqual([
      { at_least: 1, at_most: 1 },
      { at_least: 2, at_most: 2 },
      { at_least: 0, at_most: 0 },
      { at_least: 1, at_most: 1 },
      { at_least: 1, at_most: 1 },
      { at_least: 1, at_most: 1 },
    ]);
  });

  it("widens a count by each line that may match, by its cause, and never drops one", () => {
    const tally = fold([], [SPANS[0]!], [{ kind: "db", table: "scores", op: "insert", committed: true }]);
    tally.owned(line({ kind: "db", table: "scores", op: "insert", parent: TX_IDS[0] }));
    tally.owned(line({ kind: "db", table: "unknown", op: "insert", committed: true }));
    tally.owned(line({ kind: "queue", table: "scores" }));
    tally.owned(line({ kind: "db", table: "scores", op: "insert", committed: true, v: 3 }));
    tally.owned(line({ kind: "x_cache", table: "scores" }));
    tally.damaged();
    tally.unowned(readable(JSON.stringify({ trace: traceparent(U, SPANS[1]!), kind: "db", table: "scores", op: "insert", committed: true })));
    tally.unowned(readable(JSON.stringify({ trace: traceparent(U, SPANS[1]!), kind: "db", table: "rooms", op: "insert", committed: true })));
    const reading = tally.reading({ truncated: false, replaced: false });
    expect(reading.counts).toEqual([{ yes: 0, maybe: { unreadable: 1, undefined_kind: 1, unknown_version: 1, field_unknown: 1, holds_unknown: 0, commit_unknown: 1, unowned: 1 }, counted: [], left_out: [] }]);
    expect(reading.unowned).toBe(2);
    expect(rangeOf(reading.counts[0]!, false)).toEqual({ at_least: 0, at_most: null });
  });

  it("decides a write's count when the transaction's line comes after it, and counts it in its table's group then", () => {
    const tally = fold([], [], [{ kind: "db", op: "insert", committed: true }]);
    tally.owned(line({ kind: "db", table: "scores", op: "insert", parent: "t1" }));
    tally.owned(line({ kind: "db", table: "events", op: "insert", committed: true }));
    expect(tally.reading({ truncated: false, replaced: false }).counts[0]).toEqual({
      yes: 1,
      maybe: { ...NO_MAYBE, commit_unknown: 1 },
      counted: [{ kind: "db", fields: { op: "insert", table: "events" }, lines: 1 }],
      left_out: [],
    });
    tally.owned(line({ kind: "tx", id: "t1", phase: "commit" }));
    expect(tally.reading({ truncated: false, replaced: false }).counts[0]).toEqual({
      yes: 2,
      maybe: NO_MAYBE,
      counted: [
        { kind: "db", fields: { op: "insert", table: "events" }, lines: 1 },
        { kind: "db", fields: { op: "insert", table: "scores" }, lines: 1 },
      ],
      left_out: [],
    });
  });

  it("groups exactly the lines it counts, in groups of the selected kind, whatever the trace holds", () =>
    hegel.test((tc) => {
      const texts = tc.draw(gs.arrays(op, { maxSize: 14 })).map((entry) => render(entry, T, U, ""));
      const reading = fold(texts, SPANS).reading({ truncated: false, replaced: false });
      reading.counts.forEach((count, index) => {
        expect(count.counted.reduce((total, group) => total + group.lines, 0)).toBe(count.yes);
        for (const group of count.counted) expect([group.kind, group.lines > 0]).toEqual([selections[index]!.kind, true]);
      });
    }));

  it("counts the same in any order the trace's lines arrive in", () =>
    hegel.test((tc) => {
      const texts = tc.draw(gs.arrays(op, { maxSize: 14 })).map((entry) => render(entry, T, U, ""));
      const shuffled = [...texts];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = tc.draw(gs.integers({ minValue: 0, maxValue: index }));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      const counts = (lines: readonly string[]) => fold(lines, SPANS).reading({ truncated: false, replaced: false }).counts;
      expect(counts(shuffled)).toEqual(counts(texts));
    }));
});

describe("createKindsSeen", () => {
  it("knows a kind once a line of the world is an event of it, whoever's trace it carries", () => {
    const seen = createKindsSeen();
    seen.note(parseEventLine(JSON.stringify({ trace: traceparent(U, SPANS[0]!), kind: "db", table: "t", op: "read", v: 2 })));
    seen.note(parseEventLine(JSON.stringify({ trace: traceparent(U, SPANS[0]!), kind: "db", op: "read" })));
    seen.note(parseEventLine(JSON.stringify({ trace: traceparent(U, SPANS[0]!), kind: "request", method: "GET", route: null, status: 200 })));
    expect([seen.has("db"), seen.has("request")]).toEqual([false, true]);
  });
});

describe("judging a count", () => {
  const range: gs.Generator<CountRange> = gs
    .tuples(gs.integers({ minValue: 0, maxValue: 6 }), gs.oneOf(gs.integers({ minValue: 0, maxValue: 6 }), gs.just(null)))
    .map(([low, extra]) => ({ at_least: low, at_most: extra === null ? null : low + extra }));
  const expected = gs.oneOf(gs.integers({ minValue: -2, maxValue: 14 }), gs.sampledFrom([0.5, 2.5]));

  it("holds or breaks only when every count in the range gives that answer, and does whenever they all do", () =>
    hegel.test((tc) => {
      const drawn = tc.draw(range);
      const compare = tc.draw(gs.sampledFrom(COUNT_COMPARES));
      const value = tc.draw(expected);
      // Past both the lower bound and the expected value every compare
      // gives one answer, so these counts stand for an unbounded range.
      const last = drawn.at_most ?? Math.max(drawn.at_least, Math.ceil(value)) + 2;
      const answers = new Set<boolean>();
      for (let count = drawn.at_least; count <= last; count += 1) answers.add(compareCount(count, compare, value));
      const all = answers.size === 1 ? ([...answers][0] ? "held" : "broken") : "unknown";
      expect(judgeRange(drawn, compare, value)).toBe(all);
    }));

  it("names the first gap of a reading that is not whole, and the lines that may match of one that is", () => {
    expect(judgeCount({ range: { at_least: 0, at_most: null }, whole: false, open: [{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }], maybe: NO_MAYBE }, "equal", 0)).toEqual({
      outcome: "unjudged",
      reason: "the events are not whole (jobs-pending): job 3f2a9c41 was enqueued and has not performed, so the count is at least 0, with no upper bound, and equal 0 is not known",
      gap: "jobs-pending",
    });
    expect(judgeCount({ range: { at_least: 0, at_most: null }, whole: false, open: [{ gap: "world-unread" }], maybe: NO_MAYBE }, "equal", 0, "place-score@20")).toMatchObject({
      outcome: "unjudged",
      reason: "the events of place-score@20 were not read (world-unread): nukadoko did not start the world's program, so it reads no events there, so the count is at least 0, with no upper bound, and equal 0 is not known",
    });
    expect(judgeCount({ range: { at_least: 0, at_most: 1 }, whole: true, open: [], maybe: { ...NO_MAYBE, commit_unknown: 1 } }, "equal", 0)).toEqual({
      outcome: "unjudged",
      reason: "1 line has a commit state no line decides, so the count is between 0 and 1, and equal 0 is not known",
      gap: null,
    });
    expect(judgeCount({ range: { at_least: 1, at_most: null }, whole: false, open: [{ gap: "processes-unbounded" }], maybe: NO_MAYBE }, "at-least", 1)).toEqual({ outcome: "held" });
    expect(judgeCount({ range: { at_least: 2, at_most: null }, whole: false, open: [{ gap: "kind-unreported", kind: "db" }], maybe: NO_MAYBE }, "equal", 1)).toEqual({ outcome: "broken" });
  });
});
