import { isOwnKind, PATH_KINDS, valueAt, type OwnFields, type PathKind } from "../execution-events/path.js";
import { EXTENSION_PREFIX } from "../execution-events/format.js";

// Responsibility: the intent file's format (docs/intent.md): what a change
// declares it means to do differently, as one Markdown table whose rows
// are target x observation x before -> after, each cell in the execution
// events vocabulary (docs/execution-events.md). Reading it, writing it
// back, and the two questions a row answers about one entry of a path:
// does the row aim at it, and does a difference on it go the way the row
// says. Pure. Boundary: where the file is and what git says of it are
// src/run/intent-file.ts's; which criteria a row reached, and what each
// came to, are src/run/intent-view.ts's.
//
// The file is Markdown so a person reads it in the change's first commit
// and in its diff, and a table so a program in any language reads it with
// a split: another tool, such as an application's own comparison of every
// contract's decision, reads the same rows against the lines it makes and
// names nukadoko nowhere. Only the table whose header is exactly
// `| Target | Observation | Before | After |` is read; prose around it is
// for people. A cell's terms are the events vocabulary: a kind, and
// `field<op>value` over a line's fields, so a row names what the program
// reports and never a step, a criterion's text, or an id.
//
// A value is JSON when it parses as JSON and is otherwise the bare text:
// `plan:team` and `"plan:team"` are one value, and `10` is a number. A
// term ends at a space outside a JSON string or brackets, so a value with
// spaces is written as JSON (`"two words"`), and a `|` in a cell is
// written `\|`, as Markdown has it. An earlier shape put rows in commit
// trailers, where a value with spaces did not survive the round trip.
//
// Before and after say how many lines a step's path counts for an
// observation with no bare field (`0` -> `1`), or which value the bare
// field had (`["sso"]` -> `["sso","audit_log"]`). Both left empty says
// the observation is not meant to change at all, which is how a refactor
// declares that decisions stay as they were. A row that cannot be read is
// a problem named by its line, never left out in silence.

/** The file's name, at the repository's top. */
export const INTENT_FILE = "INTENT.md";

/** The header of the one table read, cell by cell. */
export const INTENT_HEADER = ["Target", "Observation", "Before", "After"] as const;

export type IntentOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** `field<op>value`, the field a dotted path into a line. */
export interface IntentTerm {
  readonly field: string;
  readonly op: IntentOp;
  readonly value: unknown;
}

/** What a row says, read. */
export interface IntentRow {
  /** Its number among the table's rows, from 1. */
  readonly row: number;
  /** Its line in the file, from 1. */
  readonly line: number;
  /** The cells as written, `\|` read as `|`. */
  readonly cells: { readonly target: string; readonly observation: string; readonly before: string; readonly after: string };
  /** The tags a criterion must carry for the row to aim at it. */
  readonly tags: readonly string[];
  /** The terms an observed line must meet for the row to aim at it. */
  readonly conditions: readonly IntentTerm[];
  /** The kind of line observed. */
  readonly kind: string;
  /** The terms that narrow which lines are observed. */
  readonly filters: readonly IntentTerm[];
  /** The field whose value is observed, or `null` when lines are counted. */
  readonly projection: string | null;
  /** What it is meant to go from and to, or `null` when it is meant not
   * to change. A count when `projection` is `null`. */
  readonly change: { readonly before: unknown; readonly after: unknown } | null;
}

export interface IntentProblem {
  /** The file's line, or `null` for the file as a whole. */
  readonly line: number | null;
  readonly message: string;
}

export interface Intent {
  readonly rows: readonly IntentRow[];
  readonly problems: readonly IntentProblem[];
}

const OPS: readonly IntentOp[] = [">=", "<=", "!=", "=", ">", "<"];
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** The cells of a Markdown table line: between its outer pipes, split at
 * each `|` that `\` does not escape, each trimmed, `\|` read as `|`. */
export function tableCells(line: string): string[] | undefined {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|") || text.length < 2 || text.endsWith("\\|")) return undefined;
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** A cell as a table line holds it: `|` escaped. */
export function cellText(value: string): string {
  return value.replaceAll("|", "\\|");
}

/** The terms of a cell, split at each run of spaces outside a JSON string
 * and outside brackets. */
export function splitTerms(text: string): string[] {
  const terms: string[] = [];
  let term = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      term += char;
      if (char === "\\") {
        term += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[" || char === "{") depth += 1;
    else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (term !== "") terms.push(term);
      term = "";
    } else term += char;
  }
  if (term !== "") terms.push(term);
  return terms;
}

/** A value as written: JSON when it parses, the bare text otherwise. */
export function valueOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A value as a cell writes it: bare when that reads back as the same
 * value and holds no space, JSON otherwise. */
export function valueText(value: unknown): string {
  if (typeof value === "string" && value !== "" && !/[\s|]/.test(value) && valueOf(value) === value) return value;
  return JSON.stringify(value);
}

function termOf(text: string): IntentTerm | { readonly bare: string } | { readonly problem: string } {
  if (FIELD.test(text)) return { bare: text };
  for (let index = 1; index < text.length; index += 1) {
    const op = OPS.find((candidate) => text.startsWith(candidate, index));
    if (op === undefined) continue;
    const field = text.slice(0, index);
    if (!FIELD.test(field)) break;
    const value = text.slice(index + op.length);
    if (value === "") return { problem: `\`${text}\` has no value after \`${op}\`` };
    return { field, op, value: valueOf(value) };
  }
  return { problem: `\`${text}\` is neither a field nor \`field<op>value\` with one of ${OPS.map((op) => `\`${op}\``).join(", ")}` };
}

/** Why a field cannot be read on a kind's lines, or `undefined`. A path
 * keeps the format's kinds by fixed fields, and a writer's own kind by
 * its own fields alone (src/execution-events/path.ts). */
function fieldProblem(kind: string, field: string): string | undefined {
  if (isOwnKind(kind)) return field.startsWith(EXTENSION_PREFIX) ? undefined : `a ${kind} line is read only at a field of its own, which starts with \`${EXTENSION_PREFIX}\`, not at \`${field}\``;
  const fields: readonly string[] = PATH_KINDS[kind as PathKind].fields;
  return fields.includes(field) ? undefined : `a path keeps a \`${kind}\` line by ${fields.map((name) => `\`${name}\``).join(", ")}, not by \`${field}\``;
}

function countOf(text: string): number | undefined {
  return /^(?:0|[1-9][0-9]*)$/.test(text) ? Number(text) : undefined;
}

function rowOf(row: number, line: number, cells: IntentRow["cells"]): IntentRow | IntentProblem {
  const problem = (message: string): IntentProblem => ({ line, message: `row ${row}: ${message}` });
  const tags: string[] = [];
  const conditions: IntentTerm[] = [];
  const targets: string[] = [];
  for (const text of splitTerms(cells.target)) {
    if (/^@\S+$/.test(text)) tags.push(text);
    else targets.push(text);
  }
  const [kind, ...observed] = splitTerms(cells.observation);
  if (kind === undefined) return problem("the observation names no kind of line");
  if (!isOwnKind(kind) && !Object.hasOwn(PATH_KINDS, kind)) {
    return problem(`\`${kind}\` is not a kind a path keeps: one of ${Object.keys(PATH_KINDS).map((name) => `\`${name}\``).join(", ")}, or a writer's own kind that starts with \`${EXTENSION_PREFIX}\``);
  }
  for (const text of targets) {
    const term = termOf(text);
    if ("problem" in term) return problem(term.problem);
    if ("bare" in term) return problem(`the target term \`${text}\` names a field with no value; a target is tags and \`field<op>value\` terms`);
    conditions.push(term);
  }
  const filters: IntentTerm[] = [];
  const projections: string[] = [];
  for (const text of observed) {
    const term = termOf(text);
    if ("problem" in term) return problem(term.problem);
    if ("bare" in term) projections.push(term.bare);
    else filters.push(term);
  }
  if (projections.length > 1) return problem(`the observation names ${projections.length} fields with no value (${projections.map((field) => `\`${field}\``).join(", ")}); it observes at most one`);
  for (const field of [...conditions.map((term) => term.field), ...filters.map((term) => term.field), ...projections]) {
    const why = fieldProblem(kind, field);
    if (why !== undefined) return problem(why);
  }
  if (kind === "db" && [...conditions, ...filters].some((term) => term.field === "op" && term.op === "=" && term.value === "read")) {
    return problem("a path keeps no database read, so `op=read` matches nothing");
  }
  const projection = projections[0] ?? null;
  if (cells.before === "" && cells.after === "") return { row, line, cells, tags, conditions, kind, filters, projection, change: null };
  if (cells.before === "" || cells.after === "") return problem("before and after are both empty, for no change, or both filled");
  if (projection === null) {
    const [before, after] = [countOf(cells.before), countOf(cells.after)];
    if (before === undefined || after === undefined) return problem(`an observation with no field to read counts lines, so before and after are whole numbers, not \`${cells.before}\` and \`${cells.after}\``);
    if (before === after) return problem(`before and after are both ${before}; leave both empty for no change`);
    return { row, line, cells, tags, conditions, kind, filters, projection, change: { before, after } };
  }
  const [before, after] = [valueOf(cells.before), valueOf(cells.after)];
  if (sameValue(before, after)) return problem(`before and after are the same value; leave both empty for no change`);
  return { row, line, cells, tags, conditions, kind, filters, projection, change: { before, after } };
}

/** Reads the intent file's text. Pure. */
export function parseIntent(text: string): Intent {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const cells = tableCells(line);
    return cells !== undefined && cells.length === INTENT_HEADER.length && cells.every((cell, index) => cell === INTENT_HEADER[index]);
  });
  if (start === -1) return { rows: [], problems: [{ line: null, message: `no table has the header \`| ${INTENT_HEADER.join(" | ")} |\`` }] };
  const rows: IntentRow[] = [];
  const problems: IntentProblem[] = [];
  const delimiter = tableCells(lines[start + 1] ?? "");
  if (delimiter === undefined || delimiter.length !== INTENT_HEADER.length || !delimiter.every((cell) => /^:?-+:?$/.test(cell))) {
    return { rows, problems: [{ line: start + 2, message: "the header is not followed by a delimiter row such as `| --- | --- | --- | --- |`" }] };
  }
  let row = 0;
  for (let index = start + 2; index < lines.length; index += 1) {
    const cells = tableCells(lines[index]!);
    if (cells === undefined) break;
    row += 1;
    if (cells.length !== INTENT_HEADER.length) {
      problems.push({ line: index + 1, message: `row ${row}: has ${cells.length} cells, not ${INTENT_HEADER.length}` });
      continue;
    }
    const [target, observation, before, after] = cells as [string, string, string, string];
    const read = rowOf(row, index + 1, { target, observation, before, after });
    if ("kind" in read) rows.push(read);
    else problems.push(read);
  }
  return { rows, problems };
}

/** The table a list of rows' cells makes, header first: what
 * `parseIntent` reads back to the same cells. */
export function intentTable(rows: readonly IntentRow["cells"][]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(cellText).join(" | ")} |`;
  return [line(INTENT_HEADER), line(INTENT_HEADER.map(() => "---")), ...rows.map((cells) => line([cells.target, cells.observation, cells.before, cells.after]))].join("\n");
}

/** For each writer's own kind a row observes, every field a row reads on
 * it, so a path counts the kind by them (src/execution-events/path.ts). */
export function ownFieldsOf(intent: Intent): OwnFields {
  const fields = new Map<string, Set<string>>();
  for (const row of intent.rows) {
    if (!isOwnKind(row.kind)) continue;
    const named = fields.get(row.kind) ?? new Set<string>();
    for (const field of [...row.conditions.map((term) => term.field), ...row.filters.map((term) => term.field), ...(row.projection === null ? [] : [row.projection])]) named.add(field);
    fields.set(row.kind, named);
  }
  return new Map([...fields].map(([kind, named]) => [kind, [...named].sort()]));
}

/** Two values are one when their JSON is, objects' keys in any order. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The value a key or a line holds at a field: a path's own key holds a
 * dotted field as one name, a line as nested objects. */
export function fieldValue(record: Readonly<Record<string, unknown>>, field: string): unknown {
  return Object.hasOwn(record, field) ? record[field] : valueAt(record, field);
}

/** Whether a term holds on a record. A field the record lacks meets no
 * term, and an order compares two numbers or two strings alone. */
export function termHolds(term: IntentTerm, record: Readonly<Record<string, unknown>>): boolean {
  const value = fieldValue(record, term.field);
  if (value === undefined) return false;
  if (term.op === "=") return sameValue(value, term.value);
  if (term.op === "!=") return !sameValue(value, term.value);
  const comparable = (typeof value === "number" && typeof term.value === "number") || (typeof value === "string" && typeof term.value === "string");
  if (!comparable) return false;
  const [a, b] = [value as number | string, term.value as number | string];
  if (term.op === "<") return a < b;
  if (term.op === "<=") return a <= b;
  if (term.op === ">") return a > b;
  return a >= b;
}

/** Whether a row aims at an entry of a path: its kind, and every
 * condition and filter holds on it. */
export function rowObserves(row: IntentRow, key: Readonly<Record<string, unknown>> & { readonly kind: string }): boolean {
  return key.kind === row.kind && [...row.conditions, ...row.filters].every((term) => termHolds(term, key));
}

/** A count's range on one side. */
export interface Range {
  readonly at_least: number;
  readonly at_most: number | null;
}

function within(range: Range, count: number): boolean {
  return range.at_least <= count && (range.at_most === null || count <= range.at_most);
}

/** Whether a difference on an entry the row observes goes the way the
 * row says. For a count: the base side can hold `before` and head
 * `after`. For a value: the entry holds `before` and fewer lines at
 * head, or `after` and more; the caller pairs the two (intent-view.ts).
 * A row meant not to change declares no difference. */
export function rowDeclares(row: IntentRow, key: Readonly<Record<string, unknown>>, a: Range, b: Range): "count" | "gone" | "came" | undefined {
  if (row.change === null) return undefined;
  if (row.projection === null) return within(a, row.change.before as number) && within(b, row.change.after as number) ? "count" : undefined;
  const value = fieldValue(key, row.projection);
  if (sameValue(value, row.change.before) && b.at_most !== null && b.at_most < a.at_least) return "gone";
  if (sameValue(value, row.change.after) && a.at_most !== null && a.at_most < b.at_least) return "came";
  return undefined;
}
