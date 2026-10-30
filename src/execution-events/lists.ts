import { EXTENSION_PREFIX, repeatedKey } from "./format.js";

// Responsibility: the lists a program prints of the places it has
// (docs/spec.md "Lists"): its routes, its flags, and its tables, one JSON
// object per line, each place named in the words the execution events
// lines use (a request line's `method` and `route`, a flag line's `name`
// and `side`, a db line's `table`), so a list joins with the lines by text
// alone. As data: every kind and
// its fields, and the one function that turns what a list command printed
// into the kind's entries or the reason it is not a list. Pure. Boundary:
// running the command is src/program/world.ts's, and what a run reads
// against a list is src/run/'s.
//
// A list is read whole or not at all. Read in part, it would leave out what
// a line it could not read named, and a request to that route would then
// read as one the list does not name, with nothing to say why. So one line
// that is not one entry of the kind, with a key the kind does not have, a
// value of the wrong type, or a method that is not uppercase (a request
// line's method is, so a lowercase one would match no request and read as
// never requested), makes the whole list unread, naming the line.
//
// A list is a set: an entry printed twice is one entry. A route printed
// twice with two handlers keeps both, since a request line names its
// method and route and not which handler ran, and a flag printed twice
// keeps every side either line declares. A table printed twice with two
// different holdings is refused, naming both lines: what a table holds
// decides whether a count counts a write to it, so neither line can win.

export interface ListedRoute {
  /** The HTTP method, uppercase, as a request line names it. */
  readonly method: string;
  /** The route template, as a request line's `route` names it. */
  readonly route: string;
  /** What the route runs, in the program's own words (`rooms#update`),
   * each once: two routes with one handler run the same code. Empty when
   * no line named one. */
  readonly handlers: readonly string[];
}

export interface ListedFlag {
  readonly name: string;
  /** Every side a flag line may name for it, each once, in the order the
   * list first named it. */
  readonly sides: readonly string[];
}

/** What a table holds, in the program's own declaration: `state`, what
 * the program is for (the default); `bookkeeping`, a record the program
 * keeps of its own work, such as telemetry or an audit trail; or
 * `infrastructure`, what its frameworks keep to run it, such as applied
 * migrations or a job queue. */
export const TABLE_HOLDS = ["state", "bookkeeping", "infrastructure"] as const;

export type TableHolds = (typeof TABLE_HOLDS)[number];

export interface ListedTable {
  /** The table, as a db line's `table` names it. */
  readonly table: string;
  /** `state` when the line names none. */
  readonly holds: TableHolds;
}

/** The entries of each kind of list. */
export interface ListedPlaces {
  readonly routes: readonly ListedRoute[];
  readonly flags: readonly ListedFlag[];
  readonly tables: readonly ListedTable[];
}

export type ListKind = keyof ListedPlaces;

interface FieldRule {
  readonly required: boolean;
  /** Why the value cannot be the field's, or `undefined` when it can be. */
  readonly problem: (value: unknown) => string | undefined;
}

function textProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "is not a string";
  return value === "" ? "is empty" : undefined;
}

function methodProblem(value: unknown): string | undefined {
  const problem = textProblem(value);
  if (problem !== undefined) return problem;
  const method = value as string;
  return method === method.toUpperCase() ? undefined : `is ${JSON.stringify(method)}, which is not uppercase, as a request line's method is`;
}

function holdsProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !(TABLE_HOLDS as readonly string[]).includes(value)) return `is ${JSON.stringify(value)}, which is not one of ${TABLE_HOLDS.join(", ")}`;
  return undefined;
}

function sidesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.every((side) => typeof side === "string")) return "is not an array of strings";
  if (value.length === 0) return "is empty";
  return value.includes("") ? "holds an empty side" : undefined;
}

/** Every kind of list and the fields its lines hold. A key that is not
 * one of them, and does not start with `x_`, is refused, so a misspelt
 * optional field is not read as absent. */
export const LIST_FIELDS = {
  routes: {
    method: { required: true, problem: methodProblem },
    route: { required: true, problem: textProblem },
    handler: { required: false, problem: textProblem },
  },
  flags: {
    name: { required: true, problem: textProblem },
    sides: { required: true, problem: sidesProblem },
  },
  tables: {
    table: { required: true, problem: textProblem },
    holds: { required: false, problem: holdsProblem },
  },
} as const satisfies Readonly<Record<ListKind, Readonly<Record<string, FieldRule>>>>;

/** Every kind, in the order a world reads them. */
export const LIST_KINDS = Object.keys(LIST_FIELDS) as readonly ListKind[];

type Line = Readonly<Record<string, unknown>>;

/** A checked line, with its line number in the output. */
interface NumberedLine {
  readonly line: Line;
  readonly number: number;
}

// What a kind's checked lines come to, merged per place, or why they are
// not one list (module header).
const COLLECT: { readonly [K in ListKind]: (lines: readonly NumberedLine[]) => ListedPlaces[K] | { readonly problem: string } } = {
  routes(numbered) {
    const routes = new Map<string, { method: string; route: string; handlers: Set<string> }>();
    for (const { line } of numbered) {
      const method = line.method as string;
      const route = line.route as string;
      const key = JSON.stringify([method, route]);
      const entry = routes.get(key) ?? { method, route, handlers: new Set<string>() };
      routes.set(key, entry);
      if (typeof line.handler === "string") entry.handlers.add(line.handler);
    }
    return [...routes.values()].map((entry) => ({ method: entry.method, route: entry.route, handlers: [...entry.handlers].sort() }));
  },
  flags(numbered) {
    const flags = new Map<string, Set<string>>();
    for (const { line } of numbered) {
      const sides = flags.get(line.name as string) ?? new Set<string>();
      flags.set(line.name as string, sides);
      for (const side of line.sides as string[]) sides.add(side);
    }
    return [...flags].map(([name, sides]) => ({ name, sides: [...sides] }));
  },
  tables(numbered) {
    const tables = new Map<string, { readonly holds: TableHolds; readonly number: number }>();
    for (const { line, number } of numbered) {
      const table = line.table as string;
      const holds = (line.holds as TableHolds | undefined) ?? "state";
      const earlier = tables.get(table);
      if (earlier === undefined) tables.set(table, { holds, number });
      else if (earlier.holds !== holds) {
        return { problem: `line ${number} says table ${JSON.stringify(table)} holds ${holds}, and line ${earlier.number} says it holds ${earlier.holds}` };
      }
    }
    return [...tables].map(([table, { holds }]) => ({ table, holds }));
  },
};

/** Line `number` of the output as an entry of `kind`, or why it is not
 * one. */
function readLine(kind: ListKind, text: string, number: number): { readonly line: Line } | { readonly problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: `line ${number} is not JSON` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: `line ${number} is not one JSON object` };
  const repeated = repeatedKey(text);
  if (repeated !== undefined) return { problem: `line ${number} holds the key ${JSON.stringify(repeated)} twice` };
  const line = value as Line;
  const fields: Readonly<Record<string, FieldRule>> = LIST_FIELDS[kind];
  for (const key of Object.keys(line)) {
    if (!Object.hasOwn(fields, key) && !key.startsWith(EXTENSION_PREFIX)) {
      return { problem: `line ${number} has the key ${JSON.stringify(key)}, which a ${kind} line does not have (${Object.keys(fields).join(", ")}, or an ${EXTENSION_PREFIX} key of the program's own)` };
    }
  }
  for (const [name, rule] of Object.entries(fields)) {
    if (!Object.hasOwn(line, name)) {
      if (rule.required) return { problem: `line ${number} has no ${name}` };
      continue;
    }
    const problem = rule.problem(line[name]);
    if (problem !== undefined) return { problem: `line ${number}'s ${name} ${problem}` };
  }
  return { line };
}

/** What a list command of `kind` printed, as the kind's entries, or why it
 * is not a list (module header). A line of whitespace alone holds no
 * entry and is passed over, so a blank line at the end, or a CR before
 * each line feed, reads as nothing. Pure. */
export function parseList<K extends ListKind>(kind: K, output: string): { readonly entries: ListedPlaces[K] } | { readonly problem: string } {
  const lines: NumberedLine[] = [];
  for (const [index, text] of output.split("\n").entries()) {
    if (text.trim() === "") continue;
    const read = readLine(kind, text.endsWith("\r") ? text.slice(0, -1) : text, index + 1);
    if ("problem" in read) return read;
    lines.push({ line: read.line, number: index + 1 });
  }
  const collected = COLLECT[kind](lines);
  return "problem" in collected ? collected : { entries: collected };
}
