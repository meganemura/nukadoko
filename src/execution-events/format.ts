// Responsibility: the execution events line format, version 1
// (docs/execution-events.md), as data: every kind and every field it
// defines, and the one function that turns a line of text into what the
// line is. Pure: no I/O, no secrets, no clock. Boundary: which step a
// line belongs to is decided from the trace id this module reads and the
// world's prefix the caller passes (`ownerOf`); what the lines of one
// trace add up to is tally.ts's.
//
// EVENT_KINDS is the only list of kinds and fields. The parser reads it,
// and a test compares it with the document's tables, so a kind added here
// and not there, or there and not here, fails.
//
// A line is an event only when its kind's required fields hold values the
// format allows. A line that breaks that is unreadable, with the reason,
// and so is one that is not one JSON object, repeats a key in one object
// (JSON.parse keeps the last, so a record would show one of two values
// and say nothing), holds an integer past 2^53 - 1 (JSON.parse rounds it,
// so an id would change silently), or has no valid `trace` or `kind`. An
// unreadable line has no owner: no trace id read from it is trusted, so no
// step's events take data from it. An optional field is passed through as
// the line wrote it.

export const EVENT_FORMAT_VERSION = 1;

/** One field of a kind, or one field every kind may carry. */
export interface FieldSpec {
  readonly type: "string" | "integer" | "number" | "boolean" | "strings" | "ids";
  readonly required: boolean;
  /** The field may hold `null`. */
  readonly nullable?: true;
  /** The values a string field may hold. */
  readonly values?: readonly string[];
}

export const DB_OPS = ["read", "insert", "update", "delete", "other"] as const;

/** The most primary keys one `ids` field holds. */
export const IDS_CAP = 100;

export const EVENT_KINDS = {
  request: {
    method: { type: "string", required: true },
    route: { type: "string", required: true, nullable: true },
    status: { type: "integer", required: true },
    calls: { type: "strings", required: false },
  },
  db: {
    table: { type: "string", required: true },
    op: { type: "string", required: true, values: DB_OPS },
    rows: { type: "integer", required: false, nullable: true },
    ids: { type: "ids", required: false },
    committed: { type: "boolean", required: false },
  },
  tx: {
    id: { type: "string", required: true },
    phase: { type: "string", required: true, values: ["commit", "rollback"] },
  },
  job: {
    name: { type: "string", required: true },
    queue: { type: "string", required: false },
    phase: { type: "string", required: true, values: ["enqueue", "perform"] },
    job_id: { type: "string", required: true },
    calls: { type: "strings", required: false },
  },
  http: {
    method: { type: "string", required: true },
    origin: { type: "string", required: true },
    path: { type: "string", required: true },
    status: { type: "integer", required: true, nullable: true },
  },
  flag: {
    name: { type: "string", required: true },
    side: { type: "string", required: true },
    gate: { type: "string", required: false, values: ["boolean", "actor", "percentage"] },
  },
  error: {
    class: { type: "string", required: true },
    handled: { type: "boolean", required: true },
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>;

/** Fields every kind may carry. `trace` and `kind` are read before the
 * kind's own fields and decide whether the line is readable at all. */
export const COMMON_FIELDS = {
  trace: { type: "string", required: true },
  kind: { type: "string", required: true },
  id: { type: "string", required: false },
  parent: { type: "string", required: false },
  actor: { type: "string", required: false },
  at: { type: "string", required: false },
  dur_ms: { type: "number", required: false },
  time: { type: "string", required: false },
  v: { type: "integer", required: false },
} as const satisfies Readonly<Record<string, FieldSpec>>;

export type EventKindName = keyof typeof EVENT_KINDS;

/** The prefix of a kind or a field a writer makes up for itself. */
export const EXTENSION_PREFIX = "x_";

/** A JSON object exactly as the line held it. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** What a line's `trace` field says: the trace id, in lowercase, and the
 * span the field names when it is a whole `traceparent`, `null` when it
 * is a bare trace id. */
export interface TraceRef {
  readonly traceId: string;
  readonly span: string | null;
}

/** What one line is. Every reader of a world's events gets it from
 * `parseEventLine`, so a line has one owner wherever it is read. */
export type ParsedLine =
  | { readonly state: "event"; readonly trace: TraceRef; readonly kind: EventKindName; readonly object: JsonObject }
  /** A kind the writer made up (`x_` prefix): kept, and read for nothing. */
  | { readonly state: "extension"; readonly trace: TraceRef; readonly kind: string; readonly object: JsonObject }
  /** A kind the format does not define, with no `x_` prefix: a mistake,
   * or a later version's kind. */
  | { readonly state: "undefined-kind"; readonly trace: TraceRef; readonly kind: string; readonly object: JsonObject }
  /** A `v` other than EVENT_FORMAT_VERSION: what the line says is not
   * known. */
  | { readonly state: "unknown-version"; readonly trace: TraceRef; readonly kind: string; readonly object: JsonObject }
  | { readonly state: "unreadable"; readonly why: string };

/** A line that has an owner: every state but `unreadable`. */
export type ReadableLine = Exclude<ParsedLine, { readonly state: "unreadable" }>;

/** What one `flag` line says: the flag, the side the program got, and
 * the gate that decided it, `null` when the line names none as text. A
 * gate is an optional field, passed through as the line wrote it, so it
 * may be a word the format does not define. */
export interface FlagEvaluation {
  readonly name: string;
  readonly side: string;
  readonly gate: string | null;
}

/** The evaluation a `flag` event reports, or `undefined` for any other
 * line. */
export function flagOf(line: ParsedLine): FlagEvaluation | undefined {
  if (line.state !== "event" || line.kind !== "flag") return undefined;
  // The parser read both as strings, or the line would not be an event.
  const { name, side, gate } = line.object as { readonly name: string; readonly side: string; readonly gate?: unknown };
  return { name, side, gate: typeof gate === "string" ? gate : null };
}

/** What one `request` line says the program served: the method, the
 * route that matched, `null` when none did, and the status. */
export interface ServedRequest {
  readonly method: string;
  readonly route: string | null;
  readonly status: number;
}

/** The request a `request` event reports, or `undefined` for any other
 * line. */
export function requestOf(line: ParsedLine): ServedRequest | undefined {
  if (line.state !== "event" || line.kind !== "request") return undefined;
  // The parser read each field in its type, or the line would not be an
  // event.
  const { method, route, status } = line.object as { readonly method: string; readonly route: string | null; readonly status: number };
  return { method, route, status };
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const BARE_TRACE_ID = /^[0-9a-f]{32}$/;
const ALL_ZEROS = /^0+$/;

/** A W3C `traceparent` (`00-<32 hex>-<16 hex>-<2 hex>`, any version but
 * `ff`) or a bare 32-character trace id, in either case, with no id of
 * all zeros; `undefined` for anything else. */
export function traceRefOf(value: unknown): TraceRef | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.toLowerCase();
  if (BARE_TRACE_ID.test(text)) return ALL_ZEROS.test(text) ? undefined : { traceId: text, span: null };
  const match = TRACEPARENT.exec(text);
  if (match === null) return undefined;
  const [, version, traceId, span] = match as unknown as [string, string, string, string];
  if (version === "ff" || ALL_ZEROS.test(traceId) || ALL_ZEROS.test(span)) return undefined;
  return { traceId, span };
}

/** The trace id of a step a line belongs to, in a world whose trace ids
 * start with `prefix`, or `null`: an unreadable line, or a trace the
 * program made for a request nukadoko did not stamp. */
export function ownerOf(line: ParsedLine, prefix: string): string | null {
  if (line.state === "unreadable") return null;
  return line.trace.traceId.startsWith(prefix) ? line.trace.traceId : null;
}

class UnsafeInteger extends Error {}

type SourceReviver = (this: unknown, key: string, value: unknown, context: { readonly source?: string }) => unknown;

const INTEGER_SOURCE = /^-?\d+$/;

/** Throws UnsafeInteger at an integer literal JSON.parse would round. */
const integersStayExact: SourceReviver = (_key, value, context) => {
  if (typeof value === "number" && context?.source !== undefined && INTEGER_SOURCE.test(context.source) && !Number.isSafeInteger(value)) {
    throw new UnsafeInteger();
  }
  return value;
};

/** The first key one object of `text` holds twice, or `undefined`.
 * `text` is JSON that parsed, so every string and bracket is whole. */
export function repeatedKey(text: string): string | undefined {
  const frames: { readonly keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') {
      const start = at;
      for (at += 1; text[at] !== '"'; at += 1) if (text[at] === "\\") at += 1;
      const top = frames.at(-1);
      if (top?.keys !== null && top !== undefined && top.expectKey) {
        const key = JSON.parse(text.slice(start, at + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
    } else if (char === "{") {
      frames.push({ keys: new Set(), expectKey: true });
    } else if (char === "[") {
      frames.push({ keys: null, expectKey: false });
    } else if (char === "}" || char === "]") {
      frames.pop();
    } else if (char === ",") {
      const top = frames.at(-1);
      if (top?.keys !== null && top !== undefined) top.expectKey = true;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` does not fit `spec`, or `undefined` when it does. */
function fieldProblem(value: unknown, spec: FieldSpec): string | undefined {
  if (value === null) return spec.nullable === true ? undefined : "is null";
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return "is not a string";
      if (spec.values !== undefined && !spec.values.includes(value)) return `is ${JSON.stringify(value)}, which is not one of ${spec.values.join(", ")}`;
      return undefined;
    case "integer":
      return Number.isSafeInteger(value) ? undefined : "is not an integer";
    case "number":
      return typeof value === "number" ? undefined : "is not a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "is not true or false";
    case "strings":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "is not an array of strings";
    case "ids":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" || Number.isSafeInteger(item))) return "is not an array of strings or integers";
      return value.length > IDS_CAP ? `holds ${value.length} ids, more than ${IDS_CAP}` : undefined;
  }
}

function unreadable(why: string): ParsedLine {
  return { state: "unreadable", why };
}

/** Reads one line of a world's events file, without its line feed. */
export function parseEventLine(text: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(text, integersStayExact as Parameters<typeof JSON.parse>[1]);
  } catch (error) {
    return unreadable(error instanceof UnsafeInteger ? "holds an integer past 2^53 - 1; a writer writes a larger id as a string" : "is not JSON");
  }
  if (!isPlainObject(value)) return unreadable("is not one JSON object");
  const repeated = repeatedKey(text);
  if (repeated !== undefined) return unreadable(`holds the key ${JSON.stringify(repeated)} twice in one object`);
  const trace = traceRefOf(value.trace);
  if (trace === undefined) return unreadable("has no trace that is a traceparent or a 32-character trace id");
  const kind = value.kind;
  if (typeof kind !== "string" || kind === "") return unreadable("has no kind");
  if (value.v !== undefined && value.v !== EVENT_FORMAT_VERSION) return { state: "unknown-version", trace, kind, object: value };
  if (kind.startsWith(EXTENSION_PREFIX)) return { state: "extension", trace, kind, object: value };
  if (!Object.hasOwn(EVENT_KINDS, kind)) return { state: "undefined-kind", trace, kind, object: value };
  const fields: Readonly<Record<string, FieldSpec>> = EVENT_KINDS[kind as EventKindName];
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec.required) continue;
    if (!Object.hasOwn(value, name)) return unreadable(`is a ${kind} line with no ${name}`);
    const problem = fieldProblem(value[name], spec);
    if (problem !== undefined) return unreadable(`is a ${kind} line whose ${name} ${problem}`);
  }
  return { state: "event", trace, kind: kind as EventKindName, object: value };
}
