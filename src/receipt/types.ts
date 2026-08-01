// Responsibility: the receipt shape from docs/spec.md "Receipts", typed as
// the discriminated union `status` actually implies — `ReceiptOk` carries
// `result`, `ReceiptFailed` carries `error`, never both. `scenario` is typed
// as its only possible value (`null`) today because `nuka run` is a later
// slice; `session` and `environment` were each widened in turn as their own
// slices landed instead of being left open from the start — `session` from
// a `null`-only placeholder to `string | null` (sessions slice), and now
// `environment` from a `"default"`-only placeholder to `string`, plus the
// new optional `target_version` (m1-environments task spec, decision 6) —
// the deliberate widening this file's original comment anticipated.

export interface EvidenceMeta {
  /** Receipt directory, relative to the project root (e.g.
   * ".nukadoko/receipts/rcpt-..."). */
  dir: string;
  /** Present only when a browser was used. */
  trace?: string;
  /** Screenshot file names actually written; empty when no browser was used. */
  screenshots: string[];
  /** Present only when at least one `ctx.request()` call was logged. */
  http?: string;
}

interface ReceiptBase {
  receipt_id: string;
  step: string;
  kind: "do";
  /** Exactly what `--args` deserialized to, unvalidated and uncoerced. */
  args: unknown;
  /** The `--env` name this run targeted; `"default"` when `--env` was
   * omitted. Not a special value in the schema sense — docs/spec.md
   * "Sessions, environments, secrets": default is just the name of an
   * environment that may or may not itself be configured (this task's spec,
   * decision 2). */
  environment: string;
  /** The `--session` name this run carried, or `null` when none was given
   * (docs/spec.md "Sessions...": no `--session` means a clean start, never
   * an implicit shared session). */
  session: string | null;
  tag: string | null;
  /** Scenario runs (`nuka run`) are a later slice; always null from `do`. */
  scenario: null;
  started_at: string;
  finished_at: string;
  evidence: EvidenceMeta;
  /** The environment's `version` probe result (docs/spec.md "Receipts":
   * optional, "(when probed)"). Present only when the environment configures
   * a probe *and* it resolved to a string within its timeout; omitted — not
   * `null` — when there is no probe, it throws, or it times out, since a
   * probe's absence or failure is metadata about the target, never a reason
   * to fail the run itself (this task's spec, decision 5). */
  target_version?: string;
}

export interface ReceiptOk extends ReceiptBase {
  status: "ok";
  /** Passed the step's `returns` schema; this is the trust anchor
   * (docs/spec.md "Receipts"). */
  result: unknown;
}

export interface ReceiptFailed extends ReceiptBase {
  status: "failed";
  error: { message: string };
}

export type Receipt = ReceiptOk | ReceiptFailed;
