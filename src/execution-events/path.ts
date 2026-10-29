import type { CountRange } from "./count.js";
import { EVENT_KINDS, flagOf, requestOf, type EventKindName, type ReadableLine, type ServedRequest } from "./format.js";
import { createTraceTally, type GapWord, type TallyInputs, type TraceGap } from "./tally.js";

// Responsibility: a step's coarse execution path, what one trace's lines
// say the program did, counted by what each line did and no finer: a
// write by table and op, a job by name and phase, a served request by
// route and status. And the range a count of one entry lies in on a path,
// by the gaps the trace leaves open. Pure. Boundary: which lines are the
// trace's, and reading them, are the caller's (src/context/events-file.ts
// folds every line of a world's file when the world stops); pairing two
// paths and saying what changed is src/run/path-view.ts's.
//
// PATH_KINDS is the one table of what a path keeps. Its order is the
// order a reader ranks a difference by: what persists outside the
// process first, then the route through it. A new kind is a row.
//
// A path leaves out what is too fine or too noisy to compare across two
// runs of one criterion: a database read (a query count moves with every
// cache), a `tx` line, a row's ids, and an actor. `pathKeyOf` is the one
// place that decides whether a line is in a path, so a table the program
// file will declare as bookkeeping (a ledger every page writes) is
// dropped there, once, for every reader of a path.
//
// A count on a path is a range, as a count claim's is (count.ts). The
// lines that may be any line (`maybe`) raise only its upper bound, and a
// trace that is not whole has none. Two facts of the format narrow that.
// The step's own requests are written inside first, so under
// `jobs-pending` alone every request line is in and a request count stays
// bounded. And a step that sent the world nothing and has no line has an
// exact empty path, since no trace of a step carries work it did not
// send.

/** What a path keeps of one kind. */
interface PathKindSpec<K extends EventKindName> {
  /** The fields of the kind's lines an entry is counted by. */
  readonly fields: readonly (keyof (typeof EVENT_KINDS)[K] & string)[];
  /** `count` compares how many lines; `seen` compares whether any line
   * did. */
  readonly compare: "count" | "seen";
  /** A db read is not in a path. */
  readonly writesOnly?: true;
  /** In a pair of environments whose conditions differ in one, a
   * difference of this kind is the switch the pair was made to compare,
   * and is named in the pair's heading, not among what changed. */
  readonly conditionPremise?: true;
}

export const PATH_KINDS = {
  error: { fields: ["class", "handled"], compare: "count" },
  db: { fields: ["table", "op"], compare: "count", writesOnly: true },
  http: { fields: ["method", "origin", "path", "status"], compare: "count" },
  job: { fields: ["name", "phase"], compare: "count" },
  request: { fields: ["method", "route", "status"], compare: "count" },
  flag: { fields: ["name", "side"], compare: "seen", conditionPremise: true },
} as const satisfies { readonly [K in EventKindName]?: PathKindSpec<K> };

export type PathKind = keyof typeof PATH_KINDS;

/** PATH_KINDS in its order: the rank of a difference. */
export const PATH_KIND_ORDER = Object.keys(PATH_KINDS) as readonly PathKind[];

/** A field's value, by the type the format gives it. */
type FieldValue<S> =
  | (S extends { readonly type: "string" } ? string : S extends { readonly type: "integer" | "number" } ? number : S extends { readonly type: "boolean" } ? boolean : never)
  | (S extends { readonly nullable: true } ? null : never);

type KeyOf<K extends PathKind> = { readonly kind: K } & {
  readonly [F in (typeof PATH_KINDS)[K]["fields"][number]]: F extends keyof (typeof EVENT_KINDS)[K] ? FieldValue<(typeof EVENT_KINDS)[K][F]> : never;
};

/** One thing a step's lines reported, by the fields its kind keeps, such
 * as `{ kind: "db", table: "scores", op: "insert" }`. */
export type PathKey = { [K in PathKind]: KeyOf<K> }[PathKind];

export type PathEntry = PathKey & {
  /** Lines that reported it. For a flag, the evaluations; a flag
   * compares only as seen or not. */
  readonly count: number;
  /** A flag's gates, as run.json's `flags` cells name them. */
  readonly gates?: readonly (string | null)[];
};

/** What one trace's lines say the program did, coarsely. */
export interface StepPath {
  /** Each `request` line, in the order the step sent the request (its
   * span's place in `stamped_spans`), then the lines with a bare trace id
   * and the `runCommand` processes' requests, as they arrived. */
  readonly requests: readonly ServedRequest[];
  /** Every other entry, in PATH_KINDS order, then by key. */
  readonly entries: readonly PathEntry[];
  /** Lines of the trace that may be any line: a kind the format does not
   * define, a later version, an unreadable line with the trace id in its
   * text. */
  readonly maybe: number;
  /** The trace's gaps, by the tally's own rules over the same lines. */
  readonly open: readonly TraceGap[];
}

export interface PathFold {
  /** A readable line whose trace is the fold's, in any order. */
  owned(line: ReadableLine): void;
  /** An unreadable line whose text carries the fold's trace id. */
  damaged(): void;
  /** The path of the lines folded so far, with what the reader knows of
   * the file. */
  path(file: { readonly truncated: boolean; readonly replaced: boolean }): StepPath;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const FORMAT_GATES: readonly string[] = EVENT_KINDS.flag.gate.values;

// The format's gates first, in its order, then a word it does not define,
// then `null`, so a reader that looks for `boolean` finds it first.
function gateOrder(gate: string | null): [number, string] {
  if (gate === null) return [FORMAT_GATES.length + 1, ""];
  const known = FORMAT_GATES.indexOf(gate);
  return [known === -1 ? FORMAT_GATES.length : known, gate];
}

/** The order of a flag's gates, wherever a list of them is shown. */
export function byGate(a: string | null, b: string | null): number {
  const [rankA, wordA] = gateOrder(a);
  const [rankB, wordB] = gateOrder(b);
  return rankA - rankB || byText(wordA, wordB);
}

/** A key as one text, the same for equal keys: what two paths are joined
 * by. */
export function pathKeyText(key: PathKey): string {
  const fields: readonly string[] = PATH_KINDS[key.kind].fields;
  return JSON.stringify([key.kind, ...fields.map((field) => (key as unknown as Readonly<Record<string, unknown>>)[field])]);
}

/** The order of entries in a path: PATH_KINDS order, then by key. */
export function byPathKey(a: PathKey, b: PathKey): number {
  return PATH_KIND_ORDER.indexOf(a.kind) - PATH_KIND_ORDER.indexOf(b.kind) || byText(pathKeyText(a), pathKeyText(b));
}

/** The entry a line counts toward, or `undefined` for a line that is not
 * in a coarse path (module header). */
export function pathKeyOf(line: ReadableLine): PathKey | undefined {
  if (line.state !== "event" || !Object.hasOwn(PATH_KINDS, line.kind)) return undefined;
  const kind = line.kind as PathKind;
  const spec: { readonly fields: readonly string[]; readonly writesOnly?: true } = PATH_KINDS[kind];
  if (spec.writesOnly === true && line.object.op === "read") return undefined;
  // The parser read every field a path keeps, since each is required.
  return Object.fromEntries([["kind", kind], ...spec.fields.map((field) => [field, line.object[field]])]) as PathKey;
}

/** The key of a served request. */
export function requestKey(request: ServedRequest): PathKey {
  return { kind: "request", method: request.method, route: request.route, status: request.status };
}

export function createPathFold(inputs: Omit<TallyInputs, "selections">): PathFold {
  const tally = createTraceTally(inputs);
  const sent = new Map(inputs.spans.map((span, index) => [span, index]));
  const requests: { readonly order: number; readonly arrived: number; readonly request: ServedRequest }[] = [];
  const counted = new Map<string, { readonly key: PathKey; count: number; readonly gates: Set<string | null> }>();
  let maybe = 0;
  return {
    owned(line) {
      tally.owned(line);
      if (line.state === "undefined-kind" || line.state === "unknown-version") maybe += 1;
      const request = requestOf(line);
      if (request !== undefined) {
        const order = line.state === "event" && line.trace.span !== null ? (sent.get(line.trace.span) ?? sent.size) : sent.size;
        requests.push({ order, arrived: requests.length, request });
        return;
      }
      const key = pathKeyOf(line);
      if (key === undefined) return;
      const text = pathKeyText(key);
      const entry = counted.get(text) ?? { key, count: 0, gates: new Set() };
      counted.set(text, entry);
      entry.count += 1;
      const flag = flagOf(line);
      if (flag !== undefined) entry.gates.add(flag.gate);
    },
    damaged() {
      tally.damaged();
      maybe += 1;
    },
    path(file) {
      const entries = [...counted.values()]
        .sort((a, b) => byPathKey(a.key, b.key))
        .map(({ key, count, gates }): PathEntry => (key.kind === "flag" ? { ...key, count, gates: [...gates].sort(byGate) } : { ...key, count }));
      return {
        requests: [...requests].sort((a, b) => a.order - b.order || a.arrived - b.arrived).map((entry) => entry.request),
        entries,
        maybe,
        open: tally.reading(file).open,
      };
    },
  };
}

/** How many lines of `path` reported `key`. */
export function countOf(path: StepPath, key: PathKey): number {
  const text = pathKeyText(key);
  if (key.kind === "request") return path.requests.filter((request) => pathKeyText(requestKey(request)) === text).length;
  return path.entries.find((entry) => pathKeyText(entry) === text)?.count ?? 0;
}

/** Every key `path` holds, its requests' included, in entry order. */
export function keysOf(path: StepPath): PathKey[] {
  const keys = new Map<string, PathKey>();
  for (const key of [...path.entries, ...path.requests.map(requestKey)]) keys.set(pathKeyText(key), key);
  return [...keys.values()].sort(byPathKey);
}

/** The gaps that leave a count on `path` unbounded: the trace's, except
 * that a step that sent nothing and has no line has none (module
 * header). */
export function boundingGaps(path: StepPath): readonly GapWord[] {
  const empty = path.entries.length === 0 && path.requests.length === 0 && path.maybe === 0;
  if (empty && path.open.length === 1 && path.open[0]!.gap === "no-requests") return [];
  return path.open.map((gap) => gap.gap);
}

/** The range the count of `key` on `path` lies in: `[n, n + maybe]` when
 * no gap leaves it open, `[n, unbounded]` under any gap but
 * `jobs-pending` alone for a request, and for a kind compared as seen,
 * clipped to seen or not. Pure. */
export function rangeOn(path: StepPath, key: PathKey): CountRange {
  const count = countOf(path, key);
  const gaps = boundingGaps(path);
  const bounded = gaps.length === 0 || (key.kind === "request" && gaps.every((gap) => gap === "jobs-pending"));
  const range = { at_least: count, at_most: bounded ? count + path.maybe : null };
  if (PATH_KINDS[key.kind].compare === "count") return range;
  return { at_least: Math.min(1, range.at_least), at_most: Math.min(1, range.at_most ?? 1) };
}
