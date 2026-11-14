import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { maybeTotal, rangeOf } from "../src/execution-events/count.js";
import { describeLeftOut } from "../src/execution-events/counted.js";
import { parseEventLine } from "../src/execution-events/format.js";
import { TABLE_HOLDS } from "../src/execution-events/lists.js";
import type { EventSelection } from "../src/execution-events/selection.js";
import { NO_MARKED_TABLES, tablesOf, type WorldTables } from "../src/execution-events/tables.js";
import { createTraceTally, type SelectionCount } from "../src/execution-events/tally.js";
import { SPANS, T, traceparent, U } from "./helpers/event-lines.js";

// Responsibility: what a world's tables list does to a count of execution
// events (src/execution-events/tables.ts, tally.ts). A db selection that
// names no table leaves out the lines on a table the program marks as
// bookkeeping or infrastructure, and names each of them as left out; one
// that names a table counts exactly what it counted with no list at all;
// leaving lines out never raises a count; and a line the tables cannot
// place may match instead of being dropped.

const TABLES = ["scores", "events", "solid_cache_entries", "unknown"] as const;
const TX = "c7e2a1f04b9d3866";

/** One line of a trace: a db statement on one of TABLES, whose commit
 * state comes from its own `committed`, from the transaction TX, or from
 * nothing; TX's end; or a request line. `owned: false` is a line no step
 * owns, read in the step's window. */
const traceLine = gs.composite((tc) => {
  const owned = tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) !== 0;
  const trace = owned ? traceparent(T, SPANS[0]!) : traceparent(U, SPANS[1]!);
  const shape = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
  if (shape === 0) return { owned, text: JSON.stringify({ trace, kind: "tx", id: TX, phase: tc.draw(gs.sampledFrom(["commit", "rollback"])) }) };
  if (shape === 1) return { owned, text: JSON.stringify({ trace, kind: "request", method: "GET", route: "/rooms/:id", status: 200 }) };
  const commit = tc.draw(gs.sampledFrom([{ committed: true }, { committed: false }, { parent: TX }, {}]));
  const op = tc.draw(gs.sampledFrom(["insert", "update", "read", "other"]));
  return { owned, text: JSON.stringify({ trace, kind: "db", table: tc.draw(gs.sampledFrom(TABLES)), op, ...(op === "read" ? {} : commit) }) };
});

/** What a program's tables list says: each named table with a holding,
 * or a list that was not read. */
const worldTables: gs.Generator<WorldTables> = gs.composite((tc) => {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) return { unread: true as const };
  const named = TABLES.filter((table) => table !== "unknown" && tc.draw(gs.booleans()));
  return tablesOf(named.map((table) => ({ table, holds: tc.draw(gs.sampledFrom(TABLE_HOLDS)) })));
});

const NAMES_NO_TABLE: readonly EventSelection[] = [
  { kind: "db", op: ["insert", "update", "delete", "other"], committed: true },
  { kind: "db", op: ["insert", "update", "delete", "other"], committed: false },
  { kind: "db", op: "read" },
];

const NAMES_A_TABLE: readonly EventSelection[] = [
  { kind: "db", table: "events", op: "insert", committed: true },
  { kind: "db", table: ["scores", "solid_cache_entries"], op: ["insert", "update", "delete", "other"], committed: true },
  { kind: "db", table: "unknown", op: "read" },
];

function countOf(lines: readonly { owned: boolean; text: string }[], selection: EventSelection, tables: WorldTables | undefined): SelectionCount {
  const tally = createTraceTally({ spans: [SPANS[0]!], spansNotKept: 0, processes: "none", processSpans: [], selections: [selection], ...(tables === undefined ? {} : { tables }) });
  for (const { owned, text } of lines) {
    const parsed = parseEventLine(text);
    if (parsed.state === "unreadable") throw new Error(text);
    if (owned) tally.owned(parsed);
    else tally.unowned(parsed);
  }
  return tally.reading({ truncated: false, replaced: false }).counts[0]!;
}

const leftOutLines = (count: SelectionCount): number => count.left_out.reduce((total, group) => total + group.lines, 0);

describe("a count under the world's tables list", () => {
  it("counts exactly what it counted with no list when its selection names a table", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(traceLine, { maxSize: 12 }));
      const selection = tc.draw(gs.sampledFrom(NAMES_A_TABLE));
      expect(countOf(lines, selection, tc.draw(worldTables))).toEqual(countOf(lines, selection, undefined));
    }));

  it("never raises a count by leaving lines out, and puts each line it no longer counts among the left out or the lines that may match", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(traceLine, { maxSize: 12 }));
      const selection = tc.draw(gs.sampledFrom(NAMES_NO_TABLE));
      const tables = tc.draw(worldTables);
      const without = countOf(lines, selection, undefined);
      const within = countOf(lines, selection, tables);
      for (const whole of [true, false]) {
        const before = rangeOf(without, whole);
        const after = rangeOf(within, whole);
        expect(after.at_least).toBeLessThanOrEqual(before.at_least);
        if (before.at_most !== null) expect(after.at_most).not.toBeNull();
        if (before.at_most !== null) expect(after.at_most!).toBeLessThanOrEqual(before.at_most);
      }
      expect(within.yes + leftOutLines(within) + within.maybe.holds_unknown).toBe(without.yes);
      expect(maybeTotal(within.maybe) - within.maybe.holds_unknown).toBeLessThanOrEqual(maybeTotal(without.maybe));
      // A list that marks nothing, or the absence of one, counts alike.
      expect(countOf(lines, selection, NO_MARKED_TABLES)).toEqual(without);
    }));

  it("leaves a line out only when its table is marked, and names it with what the table holds", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(traceLine, { maxSize: 12 }));
      const tables = tc.draw(worldTables);
      const count = countOf(lines, tc.draw(gs.sampledFrom(NAMES_NO_TABLE)), tables);
      for (const group of count.left_out) {
        expect("marked" in tables && tables.marked[group.fields.table as string]).toBe(group.holds);
      }
      for (const group of count.counted) expect("marked" in tables && Object.hasOwn(tables.marked, group.fields.table as string)).toBe(false);
      // What the count counts is exactly what its groups name.
      expect(count.counted.reduce((total, group) => total + group.lines, 0)).toBe(count.yes);
    }));
});

describe("what a count leaves out, line by line", () => {
  const writes: EventSelection = { kind: "db", op: ["insert", "update", "delete", "other"], committed: true };
  const owned = (fields: Record<string, unknown>) => ({ owned: true, text: JSON.stringify({ trace: traceparent(T, SPANS[0]!), ...fields }) });
  const marked = tablesOf([
    { table: "rooms", holds: "state" },
    { table: "events", holds: "bookkeeping" },
    { table: "solid_cache_entries", holds: "infrastructure" },
  ]);

  it("leaves out a page's committed bookkeeping and cache writes, and counts the write to state", () => {
    const lines = [
      owned({ kind: "db", table: "rooms", op: "read" }),
      owned({ kind: "db", table: "solid_cache_entries", op: "insert", committed: true }),
      owned({ kind: "db", table: "events", op: "insert", committed: true }),
      owned({ kind: "db", table: "events", op: "insert", committed: true }),
      owned({ kind: "db", table: "rooms", op: "update", committed: true }),
    ];
    const count = countOf(lines, writes, marked);
    expect(count.yes).toBe(1);
    expect(count.counted).toEqual([{ kind: "db", fields: { op: "update", table: "rooms" }, lines: 1 }]);
    expect(count.left_out).toEqual([
      { kind: "db", fields: { op: "insert", table: "events" }, lines: 2, holds: "bookkeeping" },
      { kind: "db", fields: { op: "insert", table: "solid_cache_entries" }, lines: 1, holds: "infrastructure" },
    ]);
    expect(describeLeftOut(count.left_out)).toBe("3 lines: 2 db insert into events (bookkeeping), 1 db insert into solid_cache_entries (infrastructure)");
  });

  it("leaves out the reads of a marked table from a count of reads that names no table", () => {
    const reads = [owned({ kind: "db", table: "events", op: "read" }), owned({ kind: "db", table: "rooms", op: "read" })];
    expect(countOf(reads, { kind: "db", op: "read" }, marked)).toMatchObject({ yes: 1, left_out: [{ fields: { op: "read", table: "events" }, lines: 1, holds: "bookkeeping" }] });
  });

  it("names as left out only a line that would have counted: not one that rolled back", () => {
    const lines = [owned({ kind: "db", table: "events", op: "insert", parent: TX }), owned({ kind: "tx", id: TX, phase: "rollback" })];
    expect(countOf(lines, writes, marked)).toMatchObject({ yes: 0, left_out: [] });
    const committed = [owned({ kind: "db", table: "events", op: "insert", parent: TX }), owned({ kind: "tx", id: TX, phase: "commit" })];
    expect(countOf(committed, writes, marked)).toMatchObject({ yes: 0, left_out: [{ fields: { table: "events" }, lines: 1, holds: "bookkeeping" }] });
  });

  it("may count a write whose table the writer could not name, or any write when the list was not read", () => {
    const unnamed = [owned({ kind: "db", table: "unknown", op: "insert", committed: true })];
    expect(countOf(unnamed, writes, marked)).toMatchObject({ yes: 0, maybe: { holds_unknown: 1 }, left_out: [] });
    // With no table marked, a table the writer could not name is no
    // table the count leaves out.
    expect(countOf(unnamed, writes, NO_MARKED_TABLES)).toMatchObject({ yes: 1, maybe: { holds_unknown: 0 } });
    const events = [owned({ kind: "db", table: "events", op: "insert", committed: true })];
    expect(countOf(events, writes, { unread: true })).toMatchObject({ yes: 0, maybe: { holds_unknown: 1 }, left_out: [] });
  });

  it("does not widen a count by a line no step owns on a table it leaves out", () => {
    const unowned = [{ owned: false, text: JSON.stringify({ trace: traceparent(U, SPANS[1]!), kind: "db", table: "events", op: "insert", committed: true }) }];
    expect(countOf(unowned, writes, marked).maybe.unowned).toBe(0);
    expect(countOf(unowned, writes, NO_MARKED_TABLES).maybe.unowned).toBe(1);
  });
});
