// Responsibility: the `schema_version` of every JSON document nukadoko
// writes or prints, one integer per document kind. A reader tests the
// number before it trusts a shape. A document's number moves when a field
// it already had changes meaning, type, or name, or is removed; an added
// field does not move it. Each kind has its own number, so a change to the
// tend report does not tell a step record reader to look again.

export const SCHEMA_VERSIONS = {
  step_record: 1,
  scenario_record: 1,
  run_result: 1,
  check_report: 1,
  check_codes: 1,
  steps: 1,
  describe: 1,
  tend_report: 1,
  tend_codes: 1,
  clean_plan: 1,
  explore_result: 1,
  sessions: 1,
  refusal: 1,
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
