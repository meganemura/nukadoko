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
// provenance, the receipts `ctx.resultOf` actually read a value from during
// this execution (docs/spec.md "Receipts"). Optional and omitted when
// empty — unlike `observed`, "no reads happened" is the overwhelmingly
// common case (most steps never call `resultOf` at all), so this follows
// `target_version`'s "absence is the normal case" convention instead.
//
// `used`'s own entry shape widens from a bare receipt id string to
// `{ receipt, step }` now (m6a-from-core task spec, item 5): a `from`
// injection (docs/spec.md "Chaining steps") is a second way this array gets
// populated, alongside `ctx.resultOf`, and docs/spec.md "Receipts" always
// described the richer shape — "Each entry is `{ "receipt": "rcpt-…", "step":
// "create-project" }`" — that this field is only now catching up to. `step`
// is redundant with the cited receipt (resolving it costs one more file
// read), which is exactly why it is written down anyway: a receipt legible
// on its own, without being resolved against another local working file, is
// worth the duplication. Breaking change, no back-compat shim — 0.1 hasn't
// shipped.
//
// `sections` is added now (t3-sections task spec, decisions 1-3): the labels
// `ctx.section` was called with during this execution, in call order — how
// far a step got, not how long each stage took, deliberately (no start/end
// timestamps: that shape can be added later without a breaking change,
// while a premature one would just sit unused). Optional and omitted when
// empty, the same convention `used` follows for the same reason (most steps
// never call it). No separate `error.section` field exists on
// `ReceiptFailed`: a failed step's `sections` array still carries whichever
// labels it reached before failing, and its last element already answers
// "which stage was it in" — one fact, one place to read it.
//
// `sections` widens to `SectionEntry[]` — `{ label, at }` — now (fb4-
// evidence-time task spec, item 3): "no start/end timestamps" above was a
// bet that the shape could wait, and it turned out wrong the first time a
// receipt was actually read under pressure. A real run left `status:
// "failed"` sitting next to a `final.png` that showed the target present —
// `finalize` only screenshots once `run` has already returned or thrown, so
// the two facts were roughly 8 seconds apart, and nothing on the receipt
// said so. Read without a clock, that looks like the state flickered; it
// was misdiagnosed as exactly that. A label alone says a stage was reached,
// never when relative to anything else this receipt also carries — `at`
// (ISO 8601, collected by `SectionsCollector` itself, never passed in by a
// step: a step-supplied time would be a claim, not a measurement) puts every
// label on the same absolute timeline `started_at`/`finished_at`,
// `polls`' own `at`, and each `evidence.screenshots[].at` already share, so
// "did the state actually change" and "was this read taken before it
// settled" stop being indistinguishable from a receipt alone.
//
// `polls` is added now (ctx-poll-receipt task spec): every `ctx.poll` call
// that finished during this execution, in completion order rather than call
// order — a nested poll finishes before the one containing it, so recording
// at call time would have nothing to report yet. Unlike `sections` it does
// carry timing (`attempts`, `waited_ms`): the question `polls` exists to
// answer is a timing one — one attempt at 0ms says a wait was a no-op, many
// attempts over seconds says something else was genuinely late, and those
// two looked identical from a receipt for as long as `poll` stayed a pure
// import that wrote nothing down (docs/spec.md "Context API": "poll was an
// import for exactly as long as it recorded nothing, and arriving there was
// the same mistake twice"). `outcome: "failed"` means `fn` itself threw,
// and that throw still propagates to the step — `polls` records the fact,
// never swallows it. Present only when non-empty, `used`/`sections`' own
// convention; a compat step has no `ctx` to call `poll` on, so this field is
// simply omitted for one, the same way `sections` is.
//
// `PollRecord.at` is added now (fb4-evidence-time task spec, item 4): a
// `waited_ms` duration alone has no fixed point to measure from, so a poll
// could not be placed on the same timeline `sections`' new `at` and
// `evidence.screenshots[].at` share — and putting timestamps on only one of
// "how far" (`sections`) and "how long" (`polls`) would still leave the
// other unplaceable. `at` is the poll's own start (`pollWithRecording`
// already measured it as `startedAt`; this only exposes it), so a receipt
// reader can line up every stage and every wait without opening trace.zip
// by hand.
//
// `world` is added now (m2c-typed-world task spec, item 3): a compat step's
// own World reads/writes, measured the same "always on" way `observed` is —
// deduplicated, in access order, both arrays omitted together (`used`'s own
// convention) when a step never touched `this` at all. Never present on a
// typed step's receipt: a typed step has no World to read or write (its
// `run(fixtures, args)` never receives `this`), so its own tally is always empty
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
// `required_env` is added now (env-reads-and-mutates-doc task spec, item A):
// the env var names `ctx.requireEnv` was actually called with during this
// execution — measured, the same way `used` is, since `requireEnv` is the
// one call site the library controls; a step that reads `ctx.env[name]`
// directly leaves no trace here (no `ctx.env` Proxy exists to catch that
// path, deliberately — same spec, scope). Deduplicated, in read order, and
// recorded even for a call that went on to throw `MissingEnvError`, so a
// run that failed for a missing key still shows what it asked for. Names
// only, never values — a value can be a secret. Optional and omitted when
// empty, `used`'s own convention (most steps never call `requireEnv` at
// all). Always empty, hence always omitted, for a compat step: compat's
// `this` has no counterpart to `requireEnv` (same spec, scope).
//
// `page_events` is added now (P0-page-events task spec): console errors,
// uncaught page errors, and failed requests the harness itself saw a
// browser context produce, which cucumber-js has no way to hold at all — it
// has no browser context of its own to measure from. A step can pass
// (`status: "ok"`) while the page underneath it was throwing the whole time,
// and before this field that fact left no trace on the receipt at all.
// Measured by `PageEventsCollector` (src/context/page-events.ts), which also
// documents *why* each category is shaped the way it is (console limited to
// `error`, `weberror` never carrying `Error#stack`, the 100-entries-per-
// category cap reported through the sibling `truncated` field rather than by
// changing a category's own type, fix-union task spec). Present on both
// `ReceiptOk` and `ReceiptFailed` alike, and independent of `status`: a page
// error is evidence about the page, not a verdict on the step. The whole
// field, and each of its three categories individually, is omitted when
// empty — `sections`/`used`/`declared`'s own convention — so a step that
// never called `ctx.page()`, or did and the page stayed clean, carries no
// `page_events` key at all.
//
// `error.kind` and `mutates` are added now (m3a-receipt-kinds task spec,
// decisions 1, 3): M3's Allure interop needs a machine-readable failure
// marker (Categories.json can't be generated from `error.message`, free
// text meant for humans) and a way to check a step's declared `mutates`
// against what it actually did without a second lookup. `ErrorKind` is a
// closed enum on purpose — an open string would grow one value per step and
// stop being usable as a classifier — and only the first four values name a
// failure the contract layer itself can point at (the same "Tier A" claim
// README makes); every other throw is `"step_error"`, the deliberate
// catch-all a caller falls back to whenever it isn't sure (this task's spec:
// default to step_error whenever classification is uncertain — misnaming a
// failure as a contract failure is worse than not naming it at all).
// `mutates` mirrors a step's own
// `defineStep` declaration (default `true`) so a receipt alone can be
// checked against `observed` without a second lookup into the vocabulary;
// `null` — not `false` — is a compat step's value, since compat has no
// `mutates` declaration to report at all (`then-compat-step`'s own warning
// exists for the same reason). Named `mutates`, not `declared`, because
// `declared` already means something else on this exact interface (self-
// reported allure-js data, directly above) — reusing it here would collide.
//
// `http_omitted` is added now (p3b-page-network task spec, scope item 2):
// http.jsonl now also carries page-issued document/xhr/fetch traffic (each
// entry's new `via: "page"`, alongside `ctx.request()`'s own `via:
// "request"` — see http-log.ts's own `HttpLogEntry`), but a page load's
// image/stylesheet/script/etc traffic is deliberately left off that file —
// a single load can pull in dozens, and a file holding all of it would stop
// being something a reader opens. What gets left out is never silently
// dropped: this field counts it by resourceType, e.g.
// `{ "image": 34, "stylesheet": 5, "script": 12 }` (CLAUDE.md "Nothing
// breaks silently"). Present only when at least one request was left out,
// `page_events`/`sections`' own convention. `observed` (above) is not
// narrowed by any of this — it keeps counting every request the harness
// saw, dropped or not, because it answers a different question than
// http.jsonl does; the two counts are not expected to add up to each
// other. Measured by `HttpOmittedCollector` (src/context/http-omitted.ts),
// tallied by page-http-log.ts's own `response` subscription.
//
// `actions` and its sibling `truncated` are added now (p3a-trace-per-step
// task spec, scope B): every Playwright call the step made through
// `ctx.page()`, read back out of that step's own trace chunk
// (`evidence.trace`, now a per-step file rather than one spanning the whole
// scenario — see this file's own `evidence.trace`-adjacent notes below and
// `ScenarioEvidence` in src/run/record-types.ts). Parsing lives in
// src/context/trace-actions.ts, which also documents the allowlist that
// keeps a call's own `params` from ever landing on the receipt whole (a
// `setContent` call's own HTML body is the case that motivated it). Present
// only when non-empty, `page_events`/`sections`' own convention; capped at
// 100 entries, `truncated: { actions: <true total> }` reporting the same way
// `page_events`'s own per-category `truncated` does when the cap is hit.
//
// `fixtures` is added now (P5 task spec, scope item 10): what a step's own
// bag actually cost to assemble, once user-defined fixtures
// (`config.fixtures`) exist to cost anything. Teardown is deliberately not
// here — it runs *after* a step's own receipt is already closed (this
// file's own header convention: a receipt is what happened during this one
// execution), so a teardown failure lands on `ScenarioRecord.teardown_errors`
// (src/run/record-types.ts) instead, the scenario-level counterpart to this
// field.

import type { DeclaredSnapshot } from "../compat/declared.js";
import type { HttpOmittedCounts } from "../context/http-omitted.js";
import type { ObservedCounts } from "../context/observed.js";
import type { PageEventsSnapshot } from "../context/page-events.js";
import type { ActionEntry } from "../context/trace-actions.js";
import type { UsedEntry, UsedEntryWithResult } from "../context/used.js";
import type { FixtureUsageEntry } from "../fixture/resolver.js";

export type { FixtureUsageEntry } from "../fixture/resolver.js";

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
  | "timeout"
  | "unsupported"
  | "step_error";

/** One `ctx.section` call's own record (fb4-evidence-time task spec, item 3;
 * docs/spec.md "Receipts") — a label alone said only *that* execution
 * reached a stage, never *when*; `at` is what lets it share one timeline
 * with `polls` and `evidence.screenshots` (see this file's own header for
 * why that gap turned out to matter). */
export interface SectionEntry {
  /** The string `ctx.section(label)` was called with. */
  readonly label: string;
  /** ISO 8601 — the moment `ctx.section` was called, taken by
   * `SectionsCollector` itself (src/context/sections.ts), never supplied by
   * the step: a step-supplied time would be a claim, not a measurement. */
  readonly at: string;
}

/** One `ctx.poll` call's own record (ctx-poll-receipt task spec; docs/spec.md
 * "Receipts"). */
export interface PollRecord {
  /** `options.description`, when the call was given one — included in
   * `PollTimeoutError`'s own message too (src/context/poll.ts). */
  readonly description?: string;
  /** ISO 8601 — this poll's own start (fb4-evidence-time task spec, item 4),
   * the same instant `pollWithRecording` (src/context/poll.ts) already
   * measures as `startedAt` to compute `waited_ms` from — this field just
   * exposes it, so a poll can be placed on the same absolute timeline
   * `sections` and `evidence.screenshots` share instead of read as a bare
   * duration with no fixed point to measure from. */
  readonly at: string;
  /** How many times `fn` was called. `1` means it resolved on the very
   * first attempt: the wait was a no-op, not a genuine delay. */
  readonly attempts: number;
  /** Milliseconds elapsed across the whole `ctx.poll` call, start to
   * finish. */
  readonly waited_ms: number;
  /** `"resolved"` — `fn` returned a defined value. `"timed_out"` — the
   * call's own `PollTimeoutError` fired. `"failed"` — `fn` itself threw,
   * and that throw propagated out of `ctx.poll` unchanged. */
  readonly outcome: "resolved" | "timed_out" | "failed";
}

/** One screenshot the harness actually wrote (fb4-evidence-time task spec,
 * item 2) — replaces the former bare file-name string. A second, differently
 * named file used to exist so a failed receipt's evidence was easy to spot,
 * but it was the same buffer as `final.png` written a second time: zero
 * additional information, since `receipt.status` already answers "did this
 * fail", and `finalize` only runs from `dispose` — after `run` has already
 * returned or thrown — so that second copy could show a page that had since
 * changed, without anything on the receipt saying so. `at` is what a second
 * file was standing in for without ever stating it. */
export interface ScreenshotEntry {
  /** The screenshot's file name, relative to `EvidenceMeta.dir` /
   * `ScenarioEvidence.dir` — always `"final.png"`; there is only ever one. */
  readonly file: string;
  /** ISO 8601 — the moment `page.screenshot()` resolved (src/context/
   * browser-evidence.ts's `finalize`), not when the file finished writing or
   * when `finalize` itself was called. */
  readonly at: string;
}

export interface EvidenceMeta {
  /** Receipt directory, relative to the project root (e.g.
   * ".nukadoko/receipts/rcpt-..."). */
  dir: string;
  /** Present only when a browser was used. */
  trace?: string;
  /** Screenshots actually written; empty when no browser was used. At most
   * one entry (fb4-evidence-time task spec, item 1: the second, per-outcome
   * copy is gone, so a run that used the browser writes exactly
   * `final.png`, whatever the outcome). */
  screenshots: ScreenshotEntry[];
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
  /** Env var names `ctx.requireEnv` was actually called with during this
   * execution (docs/spec.md "Receipts"; env-reads-and-mutates-doc task spec,
   * item A). Present only when non-empty; deduplicated, in read order.
   * Recorded even for a call that throws `MissingEnvError` — measured, not
   * declared, and reading `ctx.env[name]` directly instead leaves no trace
   * here. */
  required_env?: string[];
  /** `ctx.section` calls made during this execution, in call order (t3-
   * sections task spec, decisions 1-3; `at` added by fb4-evidence-time task
   * spec, item 3). Present only when non-empty; a failed step's array still
   * carries whichever labels it reached before failing — that array's last
   * element is "the last stage this execution entered", so there is no
   * separate `error.section` field duplicating the same fact. Only a typed
   * step's `ctx` has `section` (decision 5) — a compat step has no
   * counterpart on `this`, so this field is simply omitted for one, the same
   * way `used` is omitted for a typed step that never calls
   * `ctx.resultOf`. */
  sections?: SectionEntry[];
  /** Every `ctx.poll` call that finished during this execution, in
   * completion order rather than call order (ctx-poll-receipt task spec;
   * this file's own header). Present only when non-empty; only a typed
   * step's `ctx` has `poll`, so this field is simply omitted for a compat
   * step, the same way `sections` is. */
  polls?: readonly PollRecord[];
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
  /** Console errors, uncaught page errors, and failed requests the browser
   * context saw during this execution (P0-page-events task spec; this
   * file's own header) — measured, the same "harness saw it happen" way
   * `observed` is, never declared by the step. Present only when at least
   * one of `console_errors`/`page_errors`/`failed_requests` is non-empty;
   * absent when `ctx.page()` was never called this execution, or was and
   * the page stayed clean. */
  page_events?: PageEventsSnapshot;
  /** How many page-issued requests this execution made were left out of
   * http.jsonl, by resourceType — `{ "image": 34, "stylesheet": 5 }` (p3b-
   * page-network task spec, scope item 2; this file's own header). Present
   * only when at least one request was left out. */
  http_omitted?: HttpOmittedCounts;
  /** Every Playwright call this step made through `ctx.page()`, read back
   * out of this step's own trace chunk (p3a-trace-per-step task spec, scope
   * B; this file's own header) — `expect` waits included, with their own
   * `ms`. Present only when non-empty; capped at 100 entries, same
   * convention as `page_events`. Omitted, never present-and-empty, when
   * `ctx.page()` was never called this step, when the chunk itself could not
   * be read (a corrupt trace.zip — measurement must never break execution,
   * this file's own header), or when the chunk's own trace format version
   * is one this build does not know how to read (`nuka run`/`nuka do`
   * report that case once, on stderr, instead — src/context/trace-
   * actions.ts's own header). */
  actions?: readonly ActionEntry[];
  /** Present only when `actions` above hit its own 100-entry cap — the true
   * total call count, the same `{ category: <true total> }` shape
   * `page_events`'s own `truncated` field already uses, with `actions` as
   * this receipt's only category. */
  truncated?: { actions: number };
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
  /** Every `config.fixtures` entry actually resolved while assembling this
   * step's own bag (P5 task spec, scope item 10) — src/fixture/resolver.ts's
   * own `resolveFixtures`, called once per step by src/run/run-scenario.ts
   * and src/cli/do.ts alike. Present only when non-empty: a step whose own
   * `run()` destructures only builtins (or none at all) never reaches a
   * user fixture, so this field is simply omitted for one, the same
   * "absence is the normal case" convention `used`/`sections`/`polls`
   * already follow. Builtins themselves never appear here — resolving one
   * is unchanged from before P5, and was never measured this way either.
   * `setup_ms`/`at` are present only for an entry this call actually built
   * (`reused: false`); their absence on a `reused: true` entry is what
   * lets a reader tell "reused, hence fast" apart from "measured 0ms" —
   * see `FixtureUsageEntry`'s own doc comment (src/fixture/resolver.ts). */
  fixtures?: FixtureUsageEntry[];
}

export interface ReceiptOk extends ReceiptBase {
  status: "ok";
  /** Passed the step's `returns` schema; this is the trust anchor
   * (docs/spec.md "Receipts"). */
  result: unknown;
  /** The earlier executions whose validated results this execution actually
   * read from — through a `from` injection or a `ctx.resultOf` call alike
   * (docs/spec.md "Receipts"; m2pre-resultof task spec, decisions 1-2;
   * m6a-from-core task spec, item 5). Present only when non-empty;
   * deduplicated by receipt id, in read order. `UsedEntry`, not
   * `UsedEntryWithResult` (fb3-used-result task spec, type-hardening
   * follow-up): an "ok" receipt's own `used` can never carry the upstream's
   * `result` — the value is already sitting on this step's own
   * `args`/upstream receipt, and a construction site that tries to hand a
   * result-bearing entry here fails to compile instead of silently leaking
   * one. */
  used?: UsedEntry[];
}

export interface ReceiptFailed extends ReceiptBase {
  status: "failed";
  /** `message` is unchanged — the human-readable text this receipt always
   * had. `kind` is new (this task's spec, decision 1): a machine-readable
   * classification alongside it, never a replacement for it. */
  error: { message: string; kind: ErrorKind };
  /** Same field as `ReceiptOk.used`, but `UsedEntryWithResult` (fb3-used-
   * result task spec, decisions 1-3, type-hardening follow-up): a failed
   * step's receipt is exactly where a reader most needs "what upstream
   * value did this read", without opening a second receipt.json — so
   * `result` is required here, not merely allowed. */
  used?: UsedEntryWithResult[];
}

export type Receipt = ReceiptOk | ReceiptFailed;
