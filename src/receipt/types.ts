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
//
// `observed` is added now (m2pre-observed task spec, decision 3): the
// network calls the tool itself measured this execution making, never what
// a step declared. It is required on both `ReceiptOk` and `ReceiptFailed` —
// unlike `target_version`, there is no "not applicable" case for it, only
// "zero calls happened" (`{ http_reads: 0, http_writes: 0 }`).
//
// `used` is added now (m2pre-resultof task spec, decision 4): measured
// provenance, the receipt ids `ctx.resultOf` actually read a value from
// during this execution (docs/spec.md "Receipts"). Optional and omitted when
// empty — unlike `observed`, "no reads happened" is the overwhelmingly
// common case (most steps never call `resultOf` at all), so this follows
// `target_version`'s "absence is the normal case" convention instead.
//
// `world` is added now (m2c-typed-world task spec, item 3): a compat step's
// own World reads/writes, measured the same "always on" way `observed` is —
// deduplicated, in access order, both arrays omitted together (`used`'s own
// convention) when a step never touched `this` at all. Never present on a
// typed step's receipt: a typed step has no World to read or write (its
// `run(ctx, args)` never receives `this`), so its own tally is always empty
// and this field is always omitted for it — no separate "kind" check is
// needed to enforce that.
//
// `declared` is added now (m2d-allure-shim task spec, decisions 3, 5): what
// a step or its glue *reported about itself* through the allure-js runtime
// shim (src/compat/allure-runtime.ts, src/compat/declared.ts) or a compat
// World's own `this.attach`/`log`/`link` channel — kept in a field separate
// from `evidence`/`observed` on purpose, since those are the harness's own
// tool measurements and this is self-reported. Collected kind-independently
// (a typed step that imports the allure-js facade directly gets this field
// exactly the same way a compat step's glue does) and at collection time,
// not after: once written to allure-results, a declared attachment and a
// measured one are indistinguishable in allure-results itself — this field
// is what keeps them apart while there is still time to. Present only when at least one of its own
// sub-fields is non-empty; the attachment *files* themselves are never
// redacted (the same honest limit trace.zip/screenshots already have).
//
// `error.kind` and `mutates` are added now (m3a-receipt-kinds task spec,
// decisions 1, 3): M3's Allure interop needs a machine-readable failure
// marker (Categories.json can't be generated from `error.message`, free
// text meant for humans) and a way to check a step's declared `mutates`
// against what it actually did without a second lookup. `ErrorKind` is a
// closed enum on purpose — an open string would grow one value per step and
// stop being usable as a classifier — and only the first six values name a
// failure the contract layer itself can point at (the same "Tier A" claim
// README makes); every other throw is `"step_error"`, the deliberate
// catch-all a caller falls back to whenever it isn't sure (this task's spec:
// "判定に迷ったら step_error に倒す" — misnaming a failure as a contract
// failure is worse than not naming it at all). `mutates` mirrors a step's own
// `defineStep` declaration (default `true`) so a receipt alone can be
// checked against `observed` without a second lookup into the vocabulary;
// `null` — not `false` — is a compat step's value, since compat has no
// `mutates` declaration to report at all (`then-compat-step`'s own warning
// exists for the same reason). Named `mutates`, not `declared`, because
// `declared` already means something else on this exact interface (self-
// reported allure-js data, directly above) — reusing it here would collide.

import type { DeclaredSnapshot } from "../compat/declared.js";
import type { ObservedCounts } from "../context/observed.js";

/** The closed set of machine-readable failure causes a receipt's `error` can
 * carry (m3a-receipt-kinds task spec, decision 1) — see this file's own
 * header for the classification principle. Each value's own home:
 *
 *   - `args_invalid` — args failed the step's own `args` schema.
 *   - `result_invalid` — the returned value failed the step's own `returns`
 *     schema.
 *   - `binding_invalid` — a pickle step's text/table/docstring couldn't be
 *     bound into a typed step's `args` shape at all (`nuka run` only; `nuka
 *     do` has no pickle to bind from).
 *   - `world_invalid` — a declared World key's write failed its own
 *     `defineWorld` schema.
 *   - `then_mutated` — a step bound in Then position was measured writing.
 *   - `read_only_violation` — a step was measured writing under a
 *     `policy: "read-only"` environment.
 *   - `timeout` — a compat step's/hook's own `{ timeout }` (or the run's
 *     `setDefaultTimeout`) fired before it settled.
 *   - `unsupported` — a compat-only shape nukadoko doesn't implement: a
 *     `done()`-callback arity, or a `"pending"`/`"skipped"` return value.
 *   - `step_error` — anything else: the step's/hook's own code threw. Also
 *     the default whenever classification is uncertain. */
export type ErrorKind =
  | "args_invalid"
  | "result_invalid"
  | "binding_invalid"
  | "world_invalid"
  | "then_mutated"
  | "read_only_violation"
  | "timeout"
  | "unsupported"
  | "step_error";

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
  /** The owning scenario's id for a `run`-originated receipt (`kind: "run"`);
   * always `null` for a `do`-originated one. */
  scenario: string | null;
  started_at: string;
  finished_at: string;
  evidence: EvidenceMeta;
  /** Network calls the tool itself saw this execution make, through
   * `ctx.request()` and the page alike — GET/HEAD as reads, everything else
   * as writes. Measured, never declared: this is what run-time keyword
   * enforcement and read-only environments act on (docs/spec.md "Keyword
   * semantics", "Receipts"; this task's spec, decisions 1-4). */
  observed: ObservedCounts;
  /** Receipt ids whose validated results this execution actually read
   * through `ctx.resultOf` (docs/spec.md "Receipts"; this task's spec,
   * decisions 1-2). Present only when non-empty; deduplicated, in read
   * order. */
  used?: string[];
  /** A compat step's own World reads/writes (m2c-typed-world task spec,
   * item 3) — deduplicated, in access order. Present only when at least one
   * of `reads`/`writes` is non-empty; absent for a typed step (no World),
   * and absent for a compat step that never touched `this` at all. */
  world?: { reads: string[]; writes: string[] };
  /** Attachments/labels/links/parameters/logs this step (or its World
   * channel) declared through the allure-js runtime shim (m2d-allure-shim
   * task spec, decisions 3, 5) — see this file's own header for how this
   * differs from `evidence`/`observed`. Present only when at least one of
   * its own sub-fields is non-empty. */
  declared?: DeclaredSnapshot;
  /** This step's own declared `mutates` (`defineStep`'s, default `true`) —
   * the counterpart to `observed` a receipt needs to let "declared vs
   * observed" be checked from the receipt alone (this task's spec, decision
   * 3). `null` for a compat step: compat has no `mutates` declaration to
   * report (`then-compat-step` warns about exactly this gap), so `null` is a
   * third value, never coerced to `false`. Present on both `ReceiptOk` and
   * `ReceiptFailed` — the declared/observed comparison matters most for a
   * run that actually finished. */
  mutates: boolean | null;
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
  /** `message` is unchanged — the human-readable text this receipt always
   * had. `kind` is new (this task's spec, decision 1): a machine-readable
   * classification alongside it, never a replacement for it. */
  error: { message: string; kind: ErrorKind };
}

export type Receipt = ReceiptOk | ReceiptFailed;
