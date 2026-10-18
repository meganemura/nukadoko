// Responsibility: the `schema_version` of every record nukadoko writes,
// one integer per record kind. A command's `--json` document is the
// envelope src/cli/refusal.ts owns, with a version of its own. A reader
// tests the number before it trusts a shape. A record's number moves when
// a field it already had changes meaning, type, or name, or is removed; an
// added field does not move it. Each kind has its own number, so a change
// to one kind does not tell a reader of another to look again. run.json is
// the `nuka run --json` envelope, so the envelope's number versions it.

export const SCHEMA_VERSIONS = {
  step_record: 2,
} as const;

export type DocumentKind = keyof typeof SCHEMA_VERSIONS;

/** `body` with `schema_version` as its first key, so a reader that reads
 * the start of the document finds the number before the shape. */
export function versioned<K extends DocumentKind, T extends object>(
  kind: K,
  body: T,
): { readonly schema_version: (typeof SCHEMA_VERSIONS)[K] } & T {
  return { schema_version: SCHEMA_VERSIONS[kind], ...body };
}
