// Responsibility: the receipt shape from docs/spec.md "Receipts", typed as
// the discriminated union `status` actually implies — `ReceiptOk` carries
// `result`, `ReceiptFailed` carries `error`, never both. `session` and
// `environment` were each widened in turn as their own slices landed instead
// of being left open from the start — `session` from a `null`-only
// placeholder to `string | null` (sessions slice), and `environment` from a
// `"default"`-only placeholder to `string`, plus the optional
// `target_version` (m1-environments task spec, decision 6). `kind` and
// `scenario` are widened again now that `nuka run` exists (m1-run task spec,
// decision 5): `kind: "do" | "run"` tells a receipt's origin apart — the
// distinction matters for the Allure mapping and sign-off contexts, per
// docs/spec.md — and `scenario: string | null` carries the owning scenario's
// id for a `run`-originated receipt, `null` for a `do`-originated one.

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
  /** `"do"` for a `nuka do` execution, `"run"` for one step inside a `nuka
   * run` scenario (docs/spec.md "Receipts": "the same shape whether the step
   * ran inside a scenario or via `do`"). */
  kind: "do" | "run";
  /** Exactly what `--args` deserialized to (`do`) or what the pickle step's
   * captures/table/docstring bound (`run`) — unvalidated and uncoerced by
   * the step's own `args` schema either way. */
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
  /** The owning scenario's id for a `run`-originated receipt (`kind: "run"`);
   * always `null` for a `do`-originated one. */
  scenario: string | null;
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
