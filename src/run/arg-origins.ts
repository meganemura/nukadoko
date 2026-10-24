import type { ArgOrigin } from "../record/types.js";

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

/** The source a claim record names for an args key (docs/spec.md
 * "Claims"): `sentence:<key>` for a value the line wrote (a capture, the
 * docstring, or the table), `from:<step>@<line>.<key>` for a value an
 * earlier step returned, with the producing line when the caller knows it
 * and the producing record's id otherwise, and the origin's own name for a
 * value given another way. Pure. */
export function claimSourceLabel(
  key: string,
  origin: ArgOrigin | undefined,
  lineOfRecord: (stepRecordId: string) => number | null,
): string {
  if (origin === undefined || origin === "schema") return `schema:${key}`;
  if (origin === "capture" || origin === "docstring" || origin === "table") return `sentence:${key}`;
  if (origin === "command_line") return `command_line:${key}`;
  const line = lineOfRecord(origin.from.step_record_id);
  return `from:${origin.from.step}@${line ?? origin.from.step_record_id}.${origin.from.key}`;
}
