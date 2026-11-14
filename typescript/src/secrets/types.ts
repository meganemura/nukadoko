// Responsibility: the small shared vocabulary that both secrets/* modules
// and their consumers outside this directory (context/http-log.ts,
// context/create-context.ts, cli/do.ts) need. Kept dependency-free (no I/O,
// no child_process) so a module that only needs the *type* of a SecretSet —
// e.g. context/http-log.ts, which must accept one without caring how it was
// built — never has to import classify-env-files.ts's child_process
// dependency or build-secret-set.ts's filesystem reads.

/** One secret value discovered in a secret-source env file, keyed by the
 * name it was defined under. */
export interface SecretEntry {
  readonly name: string;
  readonly value: string;
  /** Set on the one entry of a world that is no secret: `value` is the
   * world's trace id prefix, and every trace id of that world, and every
   * `traceparent` value holding one, is left as it is wherever a secret's
   * spelling occurs inside it (redact.ts). nukadoko made those ids at
   * random, so they never hold a secret, and a short secret that happens
   * to occur in one would otherwise change the id a line carries. The
   * entry travels with the world's token, so every place that redacts
   * with the world's secrets keeps the ids. */
  readonly keep?: "trace-ids";
}

/** Everything `redact` (redact.ts) treats as sensitive for one run. Order
 * carries no meaning. `redact` derives its own deterministic replacement
 * order: longest spelling first, a raw value ahead of another secret's
 * percent-encoded or JSON-escaped form, and ties broken by name. */
export type SecretSet = readonly SecretEntry[];

/** docs/spec.md "Environments and secrets" Honest limits: values shorter than this are never
 * redacted. A 1-3 character "secret" would match constantly inside ordinary
 * step record text (ids, statuses, single words) and turn redaction into the
 * thing that destroys the step record it's supposed to protect. */
export const MIN_REDACTABLE_LENGTH = 4;
