import type { ArgOrigin } from "../record/types.js";
import type { ArgSide } from "../step/evaluate-claims.js";

// Responsibility: the step record's `args_origin` (docs/spec.md "Records"):
// for each key of the args a step received, where its value came from.
// Pure; the executors (run-scenario.ts, cli/do.ts) know the sources and
// pass them in.
//
// A key no source names was produced by the step's args schema during
// validation (a default, or a transform). The executors cannot see that
// key by key, since zod fills it, so it is what remains once every source
// they handed over has been named.

/** `originOf` names the source of each key the executor filled. Absent
 * when `args` is not an object with at least one key. */
export function argOrigins(
  args: unknown,
  originOf: (key: string) => ArgOrigin | undefined,
): Record<string, ArgOrigin> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.map((key) => [key, originOf(key) ?? "schema"]));
}

/** Where a claim reads an args key's value from (docs/spec.md "Claims"):
 * the origin two sides of a claim are compared by, the path inside it, and
 * the label the record names it by. `sentence:<key>` for a value the line
 * wrote (a capture, the docstring, or the table); `from:<step>@<line>.<key>`
 * for a value an earlier step returned, with the producing line when the
 * caller knows it and the producing record's id otherwise, and an origin of
 * that record and the returns key, so two keys filled from one value read
 * the same place; the origin's own name for a value given another way.
 * Pure. */
export function claimArgSide(
  key: string,
  origin: ArgOrigin | undefined,
  lineOfRecord: (stepRecordId: string) => number | null,
): ArgSide {
  if (typeof origin === "object") {
    const line = lineOfRecord(origin.from.step_record_id);
    return {
      origin: `record:${origin.from.step_record_id}`,
      segments: [origin.from.key],
      label: `from:${origin.from.step}@${line ?? origin.from.step_record_id}.${origin.from.key}`,
    };
  }
  const name = origin === undefined || origin === "schema" ? "schema" : origin === "command_line" ? "command_line" : "sentence";
  return { origin: `${name}:${key}`, segments: [], label: `${name}:${key}` };
}

/** Gherkin's escapes for a table cell: a pipe, a backslash, and a newline. */
function cellText(cell: string): string {
  return cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}

/** A table as the feature file writes it: one `| a | b |` line per row. */
export function tableText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `| ${row.map(cellText).join(" | ")} |`).join("\n");
}

/** What a line wrote for each args key it filled, for `expected_text`
 * (docs/spec.md "Claims"): each capture's text as the line has it, the
 * docstring's content, or the table. Pure. */
export function sentenceTextOf(
  captures: readonly { readonly key: string }[],
  texts: readonly string[],
  attachment: { readonly key: string; readonly docString?: string; readonly table?: readonly (readonly string[])[] } | null,
): (key: string) => string | null {
  const byKey = new Map<string, string>();
  captures.forEach((capture, index) => {
    const text = texts[index];
    if (text !== undefined) byKey.set(capture.key, text);
  });
  if (attachment !== null) {
    if (attachment.docString !== undefined) byKey.set(attachment.key, attachment.docString);
    else if (attachment.table !== undefined) byKey.set(attachment.key, tableText(attachment.table));
  }
  return (key) => byKey.get(key) ?? null;
}
