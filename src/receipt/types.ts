// Responsibility: the receipt shape from docs/spec.md "Receipts", typed as
// the discriminated union `status` actually implies — `ReceiptOk` carries
// `result`, `ReceiptFailed` carries `error`, never both. Fields a slice
// cannot yet populate for real (`environment`, `scenario`) are typed as
// their only possible value today rather than left open, so a later slice
// that implements environments/`nuka run` has to widen these types
// deliberately instead of silently becoming valid. `session` was widened by
// the sessions slice (this task's spec, item 3) from its own `null`-only
// placeholder to `string | null` — the deliberate widening this file's
// original comment anticipated.

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
  /** Fixed "default": named environments (docs/spec.md "Sessions,
   * environments, secrets") are a later slice; this field exists on every
   * receipt regardless, so it is populated with its only possible value
   * today rather than omitted. */
  environment: "default";
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
