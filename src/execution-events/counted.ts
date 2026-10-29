import type { DB_OPS, EVENT_KINDS, EventKindName, JsonObject } from "./format.js";
import { valueText } from "./selection.js";

// Responsibility: what the lines a count counted were, as a record and
// as words: the lines grouped by the fields that tell one line of the
// selected kind from another, with how many lines each group holds, and
// the groups a later count of the same selection holds more lines of.
// Pure. Boundary: which lines a count counts is selection.ts's and
// tally.ts's; this module groups the lines they say match.
//
// A reader of a count needs the work behind the number: a page's GET that
// "wrote nothing" broke on one insert, and the fix depends on whether it
// went into the table the claim is about or into a bookkeeping table. So
// a group's fields name the work a line reports (which statement on which
// table, which route and status, which job), and never a value one line
// holds alone (a line's or a job's or a transaction's id, an outgoing
// call's path, which may hold values), so the number of groups follows the
// program's vocabulary, as a step record's `kinds` does, and not the
// number of lines, and a record lists every group. Only fields the format
// requires are group fields, so every line that matched holds each of
// them; the type of GROUP_FIELDS refuses any other.

type KindFields<K extends EventKindName> = (typeof EVENT_KINDS)[K];

/** The fields of kind `K` the format requires. */
type RequiredField<K extends EventKindName> = {
  [Field in keyof KindFields<K>]: KindFields<K>[Field] extends { readonly required: true } ? Field : never;
}[keyof KindFields<K>];

/** The fields a group of each kind is told apart by, in the order its
 * record and its words name them. */
export const GROUP_FIELDS = {
  request: ["method", "route", "status"],
  db: ["op", "table"],
  tx: ["phase"],
  job: ["name", "phase"],
  http: ["method", "origin", "status"],
  flag: ["name", "side"],
  error: ["class", "handled"],
} as const satisfies { readonly [K in EventKindName]: readonly RequiredField<K>[] };

/** The lines of a count that hold the same value in each of their kind's
 * GROUP_FIELDS, and how many of them there are. */
export interface CountedGroup {
  readonly kind: EventKindName;
  /** Each of `GROUP_FIELDS[kind]`, as the lines hold it, in that order. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly lines: number;
}

/** The lines a count matched, grouped as they are folded, in any order. */
export interface LineGroups {
  /** One line the count matched: an event of the kind the groups count. */
  add(object: JsonObject): void;
  /** The groups of the lines added and of `more`, most lines first, then
   * by their values; `more` is not added. */
  groups(more?: readonly JsonObject[]): CountedGroup[];
}

function valuesOf(kind: EventKindName, fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(GROUP_FIELDS[kind].map((name) => fields[name] ?? null));
}

export function createLineGroups(kind: EventKindName): LineGroups {
  const names: readonly string[] = GROUP_FIELDS[kind];
  const lines = new Map<string, number>();
  const count = (into: Map<string, number>, object: JsonObject): void => {
    const key = valuesOf(kind, object);
    into.set(key, (into.get(key) ?? 0) + 1);
  };
  return {
    add(object) {
      count(lines, object);
    },
    groups(more = []) {
      const all = new Map(lines);
      for (const object of more) count(all, object);
      return [...all]
        .sort(([leftKey, left], [rightKey, right]) => right - left || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
        .map(([key, held]) => {
          const values = JSON.parse(key) as (string | number | boolean | null)[];
          return { kind, fields: Object.fromEntries(names.map((name, index) => [name, values[index] ?? null])), lines: held };
        });
    },
  };
}

/** The groups `after` holds more lines of than `before`, each with how
 * many more: what a later count of the same selection counted that an
 * earlier one did not. A group `after` holds fewer lines of is not one.
 * Pure. */
export function groupsAdded(before: readonly CountedGroup[], after: readonly CountedGroup[]): CountedGroup[] {
  const earlier = new Map(before.map((group) => [`${group.kind}${valuesOf(group.kind, group.fields)}`, group.lines]));
  return after.flatMap((group) => {
    const more = group.lines - (earlier.get(`${group.kind}${valuesOf(group.kind, group.fields)}`) ?? 0);
    return more > 0 ? [{ ...group, lines: more }] : [];
  });
}

type GroupWords = (fields: CountedGroup["fields"]) => string;

const OP_WORDS: Readonly<Record<(typeof DB_OPS)[number], string>> = {
  read: "read from",
  insert: "insert into",
  update: "update",
  delete: "delete from",
  other: "other on",
};

/** One group in words, by kind: `db insert into events`. */
const GROUP_WORDS: { readonly [K in EventKindName]: GroupWords } = {
  request: (fields) => `request ${valueText(fields.method)} ${fields.route === null ? "(no route)" : valueText(fields.route)} ${valueText(fields.status)}`,
  db: (fields) => `db ${OP_WORDS[fields.op as (typeof DB_OPS)[number]] ?? valueText(fields.op)} ${valueText(fields.table)}`,
  tx: (fields) => `tx ${valueText(fields.phase)}`,
  job: (fields) => `job ${valueText(fields.name)} ${valueText(fields.phase)}`,
  http: (fields) => `http ${valueText(fields.method)} ${valueText(fields.origin)} ${fields.status === null ? "(no response)" : valueText(fields.status)}`,
  flag: (fields) => `flag ${valueText(fields.name)} ${valueText(fields.side)}`,
  error: (fields) => `error ${valueText(fields.class)} (${fields.handled === true ? "handled" : "not handled"})`,
};

/** How many groups a line names before it says how many lines the rest
 * hold: a held claim typically has one, and a line stays one line. */
export const GROUPS_NAMED = 3;

function linesText(count: number, more: boolean): string {
  return `${count}${more ? " more" : ""} ${count === 1 ? "line" : "lines"}`;
}

function totalOf(groups: readonly CountedGroup[]): number {
  return groups.reduce((total, group) => total + group.lines, 0);
}

/** The groups in words, the first GROUPS_NAMED of them, each with its
 * lines when there are several: `1 line: db insert into events`,
 * `3 lines: 2 db insert into scores, 1 db update rankings`, and past
 * GROUPS_NAMED `..., and 4 more lines in 2 groups`. With `more`, the count
 * reads `1 more line`. Empty for no group. Pure. */
export function describeCounted(groups: readonly CountedGroup[], more = false): string {
  if (groups.length === 0) return "";
  const named = groups.slice(0, GROUPS_NAMED).map((group) => {
    const words = GROUP_WORDS[group.kind](group.fields);
    return groups.length === 1 ? words : `${group.lines} ${words}`;
  });
  const rest = groups.slice(GROUPS_NAMED);
  const tail = rest.length === 0 ? [] : [`and ${linesText(totalOf(rest), true)} in ${rest.length} ${rest.length === 1 ? "group" : "groups"}`];
  return `${linesText(totalOf(groups), more)}: ${[...named, ...tail].join(", ")}`;
}
