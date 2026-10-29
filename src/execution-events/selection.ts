import { DB_OPS, EVENT_KINDS, EXTENSION_PREFIX, type EventKindName, type FieldSpec, type JsonObject, type ReadableLine } from "./format.js";

// Responsibility: what a count over execution events selects (one kind,
// and for each field it names, the values a line must hold), the refusal
// of a selection the format cannot judge, and what one line says about
// one selection. Pure. Boundary: which lines are a trace's, and whether a
// line's change persisted, are the caller's (tally.ts, commit-state.ts);
// a step's declaration around the selection is the step contract's.
//
// The selection type is derived from EVENT_KINDS, so a step file written
// in TypeScript that names a field its kind does not define, or a value
// outside a field's enumeration, does not compile. `selectionProblems`
// says the same at run time, for a step file written in JavaScript, in
// words a refusal can carry.
//
// A field a selection names is one whose value is one string, one number,
// or true or false: lists (`ids`, `calls`) are what later claims read, not
// what a count selects by. `committed` is not a field of the line to
// compare but the commit state the format defines (docs/execution-events.md
// "Whether a statement's change persisted"), so it has a rule of its own:
// a db selection whose `op` may be a write states it, since a write that
// was rolled back would otherwise count as written, and one that selects
// reads alone leaves it out, since a read persists nothing.
//
// A line answers a selection with `yes`, `no`, or why it may match: a kind
// the format does not define, a later version, a selected field that is
// missing or invalid, or a commit state still to be decided. A definite
// `no` on any field wins over an unknown one, since the line cannot match
// whatever the unknown field holds. A writer's own kind (`x_`) is judged
// by nothing: it is never one of the kinds a selection names.

/** The format's db operations, as a selection names them. */
type DbOp = (typeof DB_OPS)[number];

type KindFields<K extends EventKindName> = (typeof EVENT_KINDS)[K];

/** `null` for a field the format requires and allows to be `null`, where
 * `null` is a fact (`route: null`: no route matched). An optional field
 * that holds `null` says nothing a selection can match. */
type NullOf<Spec> = Spec extends { readonly required: true; readonly nullable: true } ? null : never;

/** The value a selection names for a field described by `Spec`, or
 * `never` for a field no selection names. */
type ValueOf<Spec> = Spec extends { readonly type: "string"; readonly values: readonly (infer Value)[] }
  ? Value | NullOf<Spec>
  : Spec extends { readonly type: "string" }
    ? string | NullOf<Spec>
    : Spec extends { readonly type: "integer" }
      ? number | NullOf<Spec>
      : Spec extends { readonly type: "boolean" }
        ? boolean
        : never;

/** The fields of kind `K` a selection may name, `committed` aside. */
type SelectableName<K extends EventKindName> = {
  [Field in keyof KindFields<K>]: Field extends "committed" ? never : [ValueOf<KindFields<K>[Field]>] extends [never] ? never : Field;
}[keyof KindFields<K>];

/** One value, or any of several: a list that is not empty. */
export type Match<Value> = Value | readonly [Value, ...Value[]];

/** A value a step's sentence supplies: the capture of that name, filled
 * when the line runs. */
export interface SentenceValue {
  readonly sentence: string;
}

type FieldsOf<K extends EventKindName, Extra> = {
  readonly [Field in SelectableName<K>]?: Match<ValueOf<KindFields<K>[Field]> | Extra>;
};

/** A db selection's `op` and `committed`, together: reads alone and no
 * `committed`, or `committed` stated beside anything that may be a write.
 * A list of reads alone with `committed` compiles, and is refused at run
 * time (`selectionProblems`). */
type DbCommit<Extra> =
  | { readonly op: "read" | readonly ["read"]; readonly committed?: never }
  | { readonly op?: Exclude<DbOp, "read"> | readonly [DbOp | Extra, ...(DbOp | Extra)[]] | Extra; readonly committed: boolean };

type KindSelection<K extends EventKindName, Extra> = K extends "db"
  ? { readonly kind: "db" } & Omit<FieldsOf<"db", Extra>, "op"> & DbCommit<Extra>
  : { readonly kind: K } & FieldsOf<K, Extra>;

/** What a count over execution events counts: the lines of one kind that
 * hold, for each field the selection names, its value or one of its
 * values. A field it does not name matches anything. */
export type EventSelection = { [K in EventKindName]: KindSelection<K, never> }[EventKindName];

/** A selection as a step declares it: any value may come from the
 * sentence (`{ sentence: "table" }`) instead of the step file. */
export type DeclaredEventSelection = { [K in EventKindName]: KindSelection<K, SentenceValue> }[EventKindName];

/** What one line says about one selection: it matches, it does not, it
 * matches if its change persisted as the selection states
 * (`commit-state`), or it may match, for the reason named. The names of
 * the reasons are the causes a count's `maybe` counts by. */
export type LineMatch = "yes" | "no" | "commit-state" | "field_unknown" | "undefined_kind" | "unknown_version";

const KIND_NAMES = Object.keys(EVENT_KINDS) as readonly EventKindName[];

function fieldsOfKind(kind: EventKindName): Readonly<Record<string, FieldSpec>> {
  return EVENT_KINDS[kind];
}

/** Whether a selection may name `spec`'s field (module header). */
function selectable(name: string, spec: FieldSpec): boolean {
  return name !== "committed" && (spec.type === "string" || spec.type === "integer" || spec.type === "boolean");
}

/** Whether `value` is one a selection may name for `spec`'s field. */
function fitsField(value: unknown, spec: FieldSpec): boolean {
  if (value === null) return spec.required && spec.nullable === true;
  switch (spec.type) {
    case "string":
      return typeof value === "string" && (spec.values === undefined || spec.values.includes(value));
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function valueWords(spec: FieldSpec): string {
  const kinds = { string: "a string", integer: "an integer", boolean: "true or false", number: "a number", strings: "a list of strings", ids: "a list of ids" } as const;
  const one = spec.values === undefined ? kinds[spec.type] : `one of ${spec.values.join(", ")}`;
  return spec.required && spec.nullable === true ? `${one}, or null` : one;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSentenceValue(value: unknown): value is SentenceValue {
  return isPlainObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "sentence");
}

/** The values a selection names for one field, as a list. */
function valuesOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Whether every op value a db selection names is `read`. A value from
 * the sentence may be a write, since it is not known before the line
 * runs, and so may every op when the selection names none. */
function readsAlone(op: unknown): boolean {
  if (op === undefined) return false;
  return valuesOf(op).every((value) => value === "read");
}

/** Why `value` is not a selection the format can judge, one message per
 * problem, each starting with `where` (a path such as
 * `events.writes.count`). Empty when it is one. `value` is a declared
 * selection: a value may come from the sentence. Pure. */
export function selectionProblems(value: unknown, where: string): string[] {
  const kinds = KIND_NAMES.join(", ");
  if (!isPlainObject(value)) return [`${where} is not an object that names a kind and the values of its fields; name one of the kinds ${kinds}`];
  const kind = value.kind;
  if (typeof kind !== "string") return [`${where}.kind is missing; name one of the kinds ${kinds}`];
  if (kind.startsWith(EXTENSION_PREFIX)) {
    return [`${where}.kind is ${JSON.stringify(kind)}, a writer's own kind, whose fields the format does not define, so a count judges no line of it; count one of the kinds ${kinds}`];
  }
  if (!Object.hasOwn(EVENT_KINDS, kind)) return [`${where}.kind is ${JSON.stringify(kind)}, which the execution events format does not define; its kinds are ${kinds}`];
  const fields = fieldsOfKind(kind as EventKindName);
  const names = Object.entries(fields)
    .filter(([name, spec]) => selectable(name, spec) || name === "committed")
    .map(([name]) => name);
  const problems: string[] = [];
  for (const [name, selected] of Object.entries(value)) {
    if (name === "kind") continue;
    const spec = fields[name];
    if (spec === undefined || !(selectable(name, spec) || name === "committed")) {
      const why = spec === undefined ? `which kind ${kind} does not define` : `which holds a list, and a count selects by fields that hold one value`;
      problems.push(`${where} names field ${JSON.stringify(name)}, ${why}; the fields it selects by are ${names.join(", ")}`);
      continue;
    }
    if (name === "committed") {
      if (typeof selected !== "boolean") problems.push(`${where}.committed is ${JSON.stringify(selected) ?? String(selected)}, which is not true or false`);
      continue;
    }
    const values = valuesOf(selected);
    if (Array.isArray(selected) && selected.length === 0) {
      problems.push(`${where}.${name} is an empty list, which matches no line; name at least one value`);
      continue;
    }
    const seen = new Set<string>();
    for (const one of values) {
      if (isSentenceValue(one)) {
        if (typeof one.sentence !== "string" || one.sentence === "") problems.push(`${where}.${name} takes a value from the sentence with no capture name; write { sentence: "<capture>" }`);
        continue;
      }
      if (!fitsField(one, spec)) {
        problems.push(`${where}.${name} is ${JSON.stringify(one) ?? String(one)}, which is not ${valueWords(spec)}`);
        continue;
      }
      const key = JSON.stringify(one);
      if (seen.has(key)) problems.push(`${where}.${name} names ${key} twice`);
      seen.add(key);
    }
  }
  if (kind === "db") {
    const reads = readsAlone(value.op);
    if (!reads && value.committed === undefined) {
      problems.push(`${where} selects db lines whose op may be a write and does not state committed, so a write that was rolled back would count as written; add committed: true or committed: false`);
    }
    if (reads && value.committed !== undefined) {
      problems.push(`${where} states committed beside op read; a read persists nothing, so leave committed out`);
    }
  }
  return problems;
}

/** Each value a declared selection takes from the sentence: the field
 * that names it and the capture's name, in the order the selection lists
 * its fields. Reads any value, and finds nothing in one that is not a
 * selection. Pure. */
export function selectionSentenceValues(declared: unknown): readonly { readonly field: string; readonly name: string }[] {
  if (!isPlainObject(declared)) return [];
  return Object.entries(declared).flatMap(([field, selected]) =>
    valuesOf(selected).flatMap((one) => (isSentenceValue(one) && typeof one.sentence === "string" ? [{ field, name: one.sentence }] : [])),
  );
}

/** The selection with each value from the sentence filled in by `capture`
 * (the capture's value, by name), or why the filled selection is not one
 * the format can judge: a capture whose value does not fit its field.
 * `declared` passed `selectionProblems`. Pure. */
export function resolveSelection(
  declared: DeclaredEventSelection,
  capture: (name: string) => unknown,
  where: string,
): { readonly selection: EventSelection } | { readonly problems: readonly string[] } {
  const fields = fieldsOfKind(declared.kind);
  const problems: string[] = [];
  const resolved: Record<string, unknown> = {};
  for (const [name, selected] of Object.entries(declared)) {
    if (name === "kind" || name === "committed") {
      resolved[name] = selected;
      continue;
    }
    const spec = fields[name]!;
    const fill = (one: unknown): unknown => {
      if (!isSentenceValue(one)) return one;
      const value = capture(one.sentence);
      if (!fitsField(value, spec)) problems.push(`${where}.${name} takes ${JSON.stringify(value) ?? String(value)} from the sentence's capture ${JSON.stringify(one.sentence)}, which is not ${valueWords(spec)}`);
      return value;
    };
    resolved[name] = Array.isArray(selected) ? selected.map(fill) : fill(selected);
  }
  return problems.length > 0 ? { problems } : { selection: resolved as EventSelection };
}

/** Whether a line's `value` for a field may be one of the `wanted` values
 * although it equals none: `table: "unknown"` names a table the writer
 * could not tell, and `op: "other"` may be an upsert whose branch the
 * writer did not know (docs/execution-events.md "db"). */
function undecided(kind: EventKindName, field: string, value: unknown, wanted: readonly unknown[]): boolean {
  if (kind !== "db") return false;
  if (field === "table") return value === "unknown";
  if (field === "op") return value === "other" && wanted.some((op) => op === "insert" || op === "update" || op === "delete");
  return false;
}

/** What `line` says about `selection` (module header). Pure. */
export function matchLine(selection: EventSelection, line: ReadableLine): LineMatch {
  if (line.state === "extension") return "no";
  if (line.state === "undefined-kind") return "undefined_kind";
  if (line.state === "unknown-version") return "unknown_version";
  if (line.kind !== selection.kind) return "no";
  const fields = fieldsOfKind(line.kind);
  let unknown = false;
  for (const [name, selected] of Object.entries(selection)) {
    if (name === "kind" || name === "committed") continue;
    const spec = fields[name]!;
    const wanted = valuesOf(selected);
    const value = line.object[name];
    // An optional field the line leaves out, or holds a value the format
    // does not allow, says nothing about what the line did.
    if (value === undefined || !fitsField(value, spec)) {
      unknown = true;
      continue;
    }
    if (wanted.includes(value)) continue;
    if (undecided(line.kind, name, value, wanted)) {
      unknown = true;
      continue;
    }
    return "no";
  }
  if (unknown) return "field_unknown";
  return "committed" in selection && selection.committed !== undefined ? "commit-state" : "yes";
}

function valueText(value: unknown): string {
  if (isSentenceValue(value)) return `sentence:${value.sentence}`;
  return typeof value === "string" && /^[\w:/.@-]+$/.test(value) ? value : JSON.stringify(value);
}

/** The selection in the words a record's label and a summary use:
 * `db where op in [insert, update, delete, other], committed true`, or
 * `request` for one that names no field. Fields come in the order the
 * format's table lists them, and a value the sentence supplies reads
 * `sentence:<capture>`, as a claim's label names it. Pure. */
export function describeSelection(selection: EventSelection | DeclaredEventSelection): string {
  const record = selection as unknown as JsonObject;
  const parts = Object.keys(fieldsOfKind(selection.kind)).flatMap((name) => {
    const value = record[name];
    if (value === undefined) return [];
    return [Array.isArray(value) ? `${name} in [${value.map(valueText).join(", ")}]` : `${name} ${valueText(value)}`];
  });
  return parts.length === 0 ? selection.kind : `${selection.kind} where ${parts.join(", ")}`;
}
