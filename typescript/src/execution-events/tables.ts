import type { ReadableLine } from "./format.js";
import { TABLE_HOLDS, type ListedTable, type TableHolds } from "./lists.js";
import type { EventSelection } from "./selection.js";

// Responsibility: what a world's tables list says to a count of execution
// events (docs/spec.md "Lists", "A claim on a count of events"): which
// tables hold something other than state, and whether a count of a
// selection counts a line, leaves it out, or cannot tell. Pure. Boundary:
// reading the list is lists.ts's and src/program/world.ts's; what a line
// says of a selection's fields is selection.ts's, and the count itself
// tally.ts's.
//
// A table the program marks as bookkeeping or infrastructure is written
// by work no sentence is about: a page that records each visit, a cache a
// page fills on a miss. A db selection that names no table means the
// tables that hold state, so the count leaves those lines out. One that
// names a table means that table, whatever it holds, so it counts exactly
// what it counted with no list at all. Leaving lines out never raises a
// count.
//
// A line the count cannot place is never dropped: a writer that could not
// name its table (`table: "unknown"`) may have written to a marked table,
// and so may any line when the world's tables list was declared and not
// read, since nukadoko then does not know which tables are marked. Such a
// line may match, and widens the range instead (`holds_unknown`).

/** What a table holds, other than state: what a count of a selection that
 * names no table leaves out. */
export type MarkedHolds = Exclude<TableHolds, "state">;

/** Every holding a count leaves out, in TABLE_HOLDS order. */
export const MARKED_HOLDS = TABLE_HOLDS.filter((holds): holds is MarkedHolds => holds !== "state");

/** What a world's tables list says, as a count reads it: the tables it
 * marks, by name, every other table holding state, or that the program
 * file names a tables list the world did not read. A world whose program
 * file names none marks no table. Plain JSON, since it crosses to a
 * `--concurrency` worker inside the world's view. */
export type WorldTables = { readonly marked: Readonly<Record<string, MarkedHolds>> } | { readonly unread: true };

/** The tables of a world whose program file names no tables list. */
export const NO_MARKED_TABLES: WorldTables = { marked: {} };

/** A read tables list, as a count reads it. Pure. */
export function tablesOf(entries: readonly ListedTable[]): WorldTables {
  const marked: Record<string, MarkedHolds> = {};
  for (const entry of entries) if (entry.holds !== "state") marked[entry.table] = entry.holds;
  return { marked };
}

/** What `table` holds by `tables`, when it is marked; `undefined` for a
 * table that holds state, or when the list was not read. */
export function markOf(tables: WorldTables, table: unknown): MarkedHolds | undefined {
  if ("unread" in tables || typeof table !== "string" || !Object.hasOwn(tables.marked, table)) return undefined;
  return tables.marked[table];
}

/** What `tables` says of a line a count of `selection` would otherwise
 * count, or may: `"counted"`, it counts as the selection's fields say;
 * a holding, the count leaves it out, since its table holds that; or
 * `"unknown"`, the line may be on a table the count leaves out (module
 * header). Only a db selection that names no table leaves a line out.
 * Pure. */
export function tableRule(selection: EventSelection, line: ReadableLine, tables: WorldTables): "counted" | MarkedHolds | "unknown" {
  if (selection.kind !== "db" || selection.table !== undefined) return "counted";
  if (line.state !== "event" || line.kind !== "db") return "counted";
  if ("unread" in tables) return "unknown";
  const table = line.object.table;
  if (table === "unknown") return Object.keys(tables.marked).length > 0 ? "unknown" : "counted";
  return markOf(tables, table) ?? "counted";
}
