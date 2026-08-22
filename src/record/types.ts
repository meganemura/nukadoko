// Responsibility: the step record shape from docs/spec.md "Records", typed as
// the discriminated union `status` actually implies — `StepRecordOk` carries
// `result`, `StepRecordFailed` carries `error`, never both. `session` and
// `environment` were each widened in turn as their own slices landed instead
// of being left open from the start — `session` from a `null`-only
// placeholder to `string | null` (sessions slice), and `environment` from a
// `"default"`-only placeholder to `string`, plus the optional
// `target_version`. `kind` and
// `scenario_record_id` are widened again now that `nuka run` exists: `kind: "do" | "run"` tells a step record's origin apart — the
// distinction matters for the Allure mapping and sign-off contexts, per
// docs/spec.md — and `scenario_record_id: string | null` carries the owning
// scenario record's id for a `run`-originated step record, `null` for a
// `do`-originated one.
//
// `kind` widens again to add `"external"`: a step run from inside a
// Playwright Test spec (src/external/record-step.ts) rather than from
// `nuka do`/`nuka run` is a third, distinct origin — the executor that
// measured it is neither of the other two. `nuka harvest` treats
// `"external"` the same as `"do"` (both are a working record, never
// evidence a sign-off can cite), while `scenario_record_id`/`run_id` stay
// `null` for it the same way they already are for a `"do"`-originated
// record: an externally-driven step belongs to no `nuka run` scenario
// either.
//
// This shape was called `Receipt` before this rename. Step-level and
// scenario-level records both answer the same question, what did this
// execution actually do, but had used two unrelated words for it: `Receipt`
// here, `record` for the scenario level (src/run/record-types.ts). One
// purpose, two vocabularies. The old name also carried little of that
// meaning on its own: a receipt, in the everyday sense, is proof a
// transaction happened, not a record of what happened during one. What the
// old name actually carried was never the name itself: it was the fact that
// `StepRecordOk.result` had passed the step's own `returns` schema. That
// fact does not move when the name does, so this rename costs a reader
// nothing they depended on.
//
// `observed` is added now: the
// network calls the tool itself measured this execution making, never what
// a step declared. It is required on both `StepRecordOk` and
// `StepRecordFailed` — unlike `target_version`, there is no "not applicable"
// case for it, only "zero calls happened" (`{ http_reads: 0, http_writes:
// 0 }`).
//
// `used` is added now: measured
// provenance, the step records `ctx.resultOf` actually read a value from
// during this execution (docs/spec.md "Records"). Optional and omitted
// when empty — unlike `observed`, "no reads happened" is the overwhelmingly
// common case (most steps never call `resultOf` at all), so this follows
// `target_version`'s "absence is the normal case" convention instead.
//
// `used`'s own entry shape widens from a bare step record id string to
// `{ step_record_id, step }`: a `from`
// injection (docs/spec.md "Chaining steps") is a second way this array gets
// populated, alongside `ctx.resultOf`, both citing the richer shape — each
// entry is `{ "step_record_id": "step-…", "step": "create-project" }`. `step`
// is redundant with the cited step record (resolving it costs one more file
// read), which is exactly why it is written down anyway: a step record
// legible on its own, without being resolved against another local working
// file, is worth the duplication. Breaking change, no back-compat shim —
// 0.1 hasn't shipped.
//
// `sections` is added now: the labels
// `ctx.section` was called with during this execution, in call order — how
// far a step got, not how long each stage took, deliberately (no start/end
// timestamps: that shape can be added later without a breaking change,
// while a premature one would just sit unused). Optional and omitted when
// empty, the same convention `used` follows for the same reason (most steps
// never call it). No separate `error.section` field exists on
// `StepRecordFailed`: a failed step's `sections` array still carries
// whichever labels it reached before failing, and its last element already
// answers "which stage was it in" — one fact, one place to read it.
//
// `sections` widens to `SectionEntry[]` — `{ label, at }` — now: "no
// start/end timestamps" above was a
// bet that the shape could wait, and it turned out wrong the first time a
// step record was actually read under pressure. A real run left `status:
// "failed"` sitting next to a `final.png` that showed the target present —
// `finalize` only screenshots once `run` has already returned or thrown, so
// the two facts were roughly 8 seconds apart, and nothing on the step
// record said so. Read without a clock, that looks like the state
// flickered; it was misdiagnosed as exactly that. A label alone says a
// stage was reached, never when relative to anything else this step record
// also carries — `at` (ISO 8601, collected by `SectionsCollector` itself,
// never passed in by a step: a step-supplied time would be a claim, not a
// measurement) puts every label on the same absolute timeline
// `started_at`/`finished_at`, `polls`' own `at`, and each
// `evidence.screenshots[].at` already share, so "did the state actually
// change" and "was this read taken before it settled" stop being
// indistinguishable from a step record alone.
//
// `polls` is added now: every `ctx.poll` call
// that finished during this execution, in completion order rather than call
// order — a nested poll finishes before the one containing it, so recording
// at call time would have nothing to report yet. Unlike `sections` it does
// carry timing (`attempts`, `waited_ms`): the question `polls` exists to
// answer is a timing one — one attempt at 0ms says a wait was a no-op, many
// attempts over seconds says something else was genuinely late, and those
// two looked identical from a step record for as long as `poll` stayed a
// pure import that wrote nothing down (docs/spec.md "Context API": "poll
// was an import for exactly as long as it recorded nothing, and arriving
// there was the same mistake twice"). `outcome: "failed"` means `fn` itself
// threw, and that throw still propagates to the step — `polls` records the
// fact, never swallows it. Present only when non-empty, `used`/`sections`'
// own convention; a compat step has no `ctx` to call `poll` on, so this
// field is simply omitted for one, the same way `sections` is.
//
// `PollRecord.at` is added now: a
// `waited_ms` duration alone has no fixed point to measure from, so a poll
// could not be placed on the same timeline `sections`' new `at` and
// `evidence.screenshots[].at` share — and putting timestamps on only one of
// "how far" (`sections`) and "how long" (`polls`) would still leave the
// other unplaceable. `at` is the poll's own start (`pollWithRecording`
// already measured it as `startedAt`; this only exposes it), so a step
// record reader can line up every stage and every wait without opening
// trace.zip by hand.
//
// `world` is added now: a compat step's
// own World reads/writes, measured the same "always on" way `observed` is —
// deduplicated, in access order, both arrays omitted together (`used`'s own
// convention) when a step never touched `this` at all. Never present on a
// typed step's step record: a typed step has no World to read or write (its
// `run(fixtures, args)` never receives `this`), so its own tally is always empty
// and this field is always omitted for it — no separate "kind" check is
// needed to enforce that.
//
// `declared` is added now: what
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
// `required_env` is added now: the env var names `ctx.requireEnv` was
// actually called with during this
// execution — measured, the same way `used` is, since `requireEnv` is the
// one call site the library controls; a step that reads `ctx.env[name]`
// directly leaves no trace here (no `ctx.env` Proxy exists to catch that
// path, deliberately). Deduplicated, in read order, and
// recorded even for a call that went on to throw `MissingEnvError`, so a
// run that failed for a missing key still shows what it asked for. Names
// only, never values — a value can be a secret. Optional and omitted when
// empty, `used`'s own convention (most steps never call `requireEnv` at
// all). Always empty, hence always omitted, for a compat step: compat's
// `this` has no counterpart to `requireEnv`.
//
// `page_events` is added now: console errors,
// uncaught page errors, and failed requests the harness itself saw a
// browser context produce, which cucumber-js has no way to hold at all — it
// has no browser context of its own to measure from. A step can pass
// (`status: "ok"`) while the page underneath it was throwing the whole time,
// and before this field that fact left no trace on the step record at all.
// Measured by `PageEventsCollector` (src/context/page-events.ts), which also
// documents *why* each category is shaped the way it is (console limited to
// `error`, `weberror` never carrying `Error#stack`, the 100-entries-per-
// category cap reported through the sibling `truncated` field rather than by
// changing a category's own type). Present on both
// `StepRecordOk` and `StepRecordFailed` alike, and independent of `status`:
// a page error is evidence about the page, not a verdict on the step. The
// whole field, and each of its three categories individually, is omitted
// when empty — `sections`/`used`/`declared`'s own convention — so a step
// that never called `ctx.page()`, or did and the page stayed clean, carries
// no `page_events` key at all.
//
// `error.kind` and `mutates` are added now: M3's Allure interop needs a machine-readable failure
// marker (Categories.json can't be generated from `error.message`, free
// text meant for humans) and a way to check a step's declared `mutates`
// against what it actually did without a second lookup. `ErrorKind` is a
// closed enum on purpose — an open string would grow one value per step and
// stop being usable as a classifier — and only the first four values name a
// failure the contract layer itself can point at (the same "Tier A" claim
// README makes); every other throw is `"step_error"`, the deliberate
// catch-all a caller falls back to whenever it isn't sure — default to
// step_error whenever classification is uncertain, since misnaming a
// failure as a contract failure is worse than not naming it at all.
// `mutates` mirrors a step's own
// `defineStep` declaration (default `true`) so a step record alone can be
// checked against `observed` without a second lookup into the vocabulary;
// `null` — not `false` — is a compat step's value, since compat has no
// `mutates` declaration to report at all (`then-compat-step`'s own warning
// exists for the same reason). Named `mutates`, not `declared`, because
// `declared` already means something else on this exact interface (self-
// reported allure-js data, directly above) — reusing it here would collide.
//
// `http_omitted` is added now: http.jsonl now also carries page-issued
// document/xhr/fetch traffic (each
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
// `actions` and its sibling `truncated` are added now: every Playwright call the step made through
// `ctx.page()`, read back out of that step's own trace chunk
// (`evidence.trace`, now a per-step file rather than one spanning the whole
// scenario — see this file's own `evidence.trace`-adjacent notes below and
// `ScenarioEvidence` in src/run/record-types.ts). Parsing lives in
// src/context/trace-actions.ts, which also documents the allowlist that
// keeps a call's own `params` from ever landing on the step record whole (a
// `setContent` call's own HTML body is the case that motivated it). Present
// only when non-empty, `page_events`/`sections`' own convention; capped at
// 100 entries, `truncated: { actions: <true total> }` reporting the same way
// `page_events`'s own per-category `truncated` does when the cap is hit.
//
// `fixtures` is added now: what a step's own
// bag actually cost to assemble, once user-defined fixtures
// (`config.fixtures`) exist to cost anything. Teardown is deliberately not
// here — it runs *after* a step's own step record is already closed (this
// file's own header convention: a step record is what happened during this
// one execution), so a teardown failure lands on
// `ScenarioRecord.teardown_errors` (src/run/record-types.ts) instead, the
// scenario-level counterpart to this field.
//
// `EvidenceMeta.attachments` is added now: the one gap the
// rest of `evidence` never covered — application-specific evidence (an API
// response body, a DB snapshot, a generated file) a step chooses to add,
// where every other member of `evidence` is something the harness collects
// on its own. `evidence.attach`/`evidence.path` (src/context/evidence.ts,
// docs/spec.md "Context API") are the two fixtures that populate it; see
// that module's own header for the collision-avoidance and cap rules.
// `at` is stamped by the collector itself, never supplied by the step —
// the same measured-not-declared rule `sections`/`polls`/
// `evidence.screenshots[].at` already follow, so an attachment lands on the
// same absolute timeline they do. Present only when non-empty; a
// `evidence.path(name)` call with nothing ever written to the path it
// returned contributes no entry (docs/spec.md "Records": step records list
// evidence only for files that exist). `truncated.evidence` (below,
// `StepRecordBase`'s own field) carries the true total once this list's own
// 100-entry cap is hit, the same sibling-field convention `truncated.actions`
// already uses.

import type { DeclaredSnapshot } from "../compat/declared.js";
import type { HttpOmittedCounts } from "../context/http-omitted.js";
import type { ObservedCounts } from "../context/observed.js";
import type { PageEventsSnapshot } from "../context/page-events.js";
import type { ActionEntry } from "../context/trace-actions.js";
import type { UsedEntry, UsedEntryWithResult } from "../context/used.js";
import type { FixtureUsageEntry } from "../fixture/resolver.js";

export type { FixtureUsageEntry } from "../fixture/resolver.js";

/** The closed set of machine-readable failure causes a step record's `error`
 * can carry — see this file's own
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

/** One `ctx.section` call's own record (docs/spec.md
 * "Records") — a label alone said only *that* execution
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

/** One `ctx.call(part, args)` invocation's own record (docs/spec.md
 * "Parts") — recorded on the *calling* step's own step record under
 * `calls`, never as a step record of its own: a part shares its caller's
 * step boundary outright, so this entry is the whole account of what it
 * did, not a pointer to a second record.json. `step` is the part's own
 * vocabulary name, the same name `nuka steps` shows for it. `args` is
 * exactly what the caller passed, unvalidated and uncoerced — the same
 * "what was actually supplied" convention `StepRecordBase.args` already
 * follows. `result` is present only when the call succeeded (the part's own
 * `returns`-validated value); `error` is present only when it didn't,
 * classified the same closed `ErrorKind` set a step record's own `error`
 * uses — no new value was added for this. A part that itself calls a part
 * nests: `calls` carries that part's own entries, present only when
 * non-empty, the same "absence is the normal case" convention every other
 * optional step-record field already follows. */
export interface CallEntry {
  readonly step: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly kind: ErrorKind };
  readonly started_at: string;
  readonly finished_at: string;
  readonly calls?: CallEntry[];
}

/** One `ctx.poll` call's own record (docs/spec.md
 * "Records"). */
export interface PollRecord {
  /** `options.description`, when the call was given one — included in
   * `PollTimeoutError`'s own message too (src/context/poll.ts). */
  readonly description?: string;
  /** ISO 8601 — this poll's own start,
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

/** One screenshot the harness actually wrote — replaces the former bare
 * file-name string. A second, differently
 * named file used to exist so a failed step record's evidence was easy to
 * spot, but it was the same buffer as `final.png` written a second time:
 * zero additional information, since `record.status` already answers "did
 * this fail", and `finalize` only runs from `dispose` — after `run` has
 * already returned or thrown — so that second copy could show a page that
 * had since changed, without anything on the step record saying so. `at`
 * is what a second file was standing in for without ever stating it. */
export interface ScreenshotEntry {
  /** The screenshot's file name, relative to `EvidenceMeta.dir` /
   * `ScenarioEvidence.dir` — always `"final.png"`; there is only ever one. */
  readonly file: string;
  /** ISO 8601 — the moment `page.screenshot()` resolved (src/context/
   * browser-evidence.ts's `finalize`), not when the file finished writing or
   * when `finalize` itself was called. */
  readonly at: string;
}

/** One `evidence.attach`/`evidence.path` result the harness confirmed
 * actually landed on disk (`EvidenceMeta.attachments`' own
 * doc comment above). `name` is what the step asked for; `file` is what was
 * actually written under `EvidenceMeta.dir` — the two can differ when the
 * same `name` was used more than once this execution (src/context/
 * evidence.ts's own collision-avoidance never overwrites, so the second use
 * gets a different `file`). `at` is taken by the collector, never the step:
 * for `evidence.attach`, the moment the write resolved; for a
 * `evidence.path`-allocated file, the file's own mtime once this execution
 * confirmed it exists. */
export interface EvidenceAttachmentEntry {
  readonly name: string;
  readonly file: string;
  readonly at: string;
}

export interface EvidenceMeta {
  /** Step record directory, relative to the project root (e.g.
   * ".nukadoko/records/steps/step-..."). */
  dir: string;
  /** Present only when a browser was used. */
  trace?: string;
  /** Screenshots actually written; empty when no browser was used. At most
   * one entry: the second, per-outcome
   * copy is gone, so a run that used the browser writes exactly
   * `final.png`, whatever the outcome. */
  screenshots: ScreenshotEntry[];
  /** Present only when at least one `ctx.request()` call was logged. */
  http?: string;
  /** Application-specific evidence `evidence.attach`/`evidence.path` added
   * this execution — this file's own header, above. Present
   * only when non-empty; capped at 100 entries, sorted by `at`. The true
   * total, once that cap is hit, is on the step record's own top-level
   * `truncated.evidence` (`StepRecordBase.truncated`, below), the same
   * sibling-field convention `truncated.actions` already uses. */
  attachments?: readonly EvidenceAttachmentEntry[];
}

interface StepRecordBase {
  step_record_id: string;
  step: string;
  /** `"do"` for a `nuka do` execution, `"run"` for one step inside a `nuka
   * run` scenario (docs/spec.md "Records": "the same shape whether the step
   * ran inside a scenario or via `do`"), `"external"` for one run from
   * inside a Playwright Test spec through `recordStep`
   * (src/external/record-step.ts) — a working record the same way `"do"`
   * is, never evidence a sign-off can cite. */
  kind: "do" | "run" | "external";
  /** Exactly what `--args` deserialized to (`do`) or what the pickle step's
   * captures/table/docstring bound (`run`) — unvalidated and uncoerced by
   * the step's own `args` schema either way. */
  args: unknown;
  /** The `--env` name this run targeted; `"default"` when `--env` was
   * omitted. Not a special value in the schema sense — docs/spec.md
   * "Sessions, environments, secrets": default is just the name of an
   * environment that may or may not itself be configured. */
  environment: string;
  /** The `--session` name this run carried, or `null` when none was given
   * (docs/spec.md "Sessions...": no `--session` means a clean start, never
   * an implicit shared session). */
  session: string | null;
  /** This execution's own 1-based position in a live session's sequence
   * (docs/spec.md "Live sessions") — present when, and only when, this
   * execution ran against a live session's own long-lived `ctx` instead of
   * a freshly built one. A single `nuka do` never sets this, live or not:
   * `session` alone cannot say whether a world was built once for this
   * execution or is thirty executions deep, and a green step record that
   * cannot be told apart from the other kind would quietly cost every
   * record around it the same certainty. */
  session_execution?: number;
  /** The owning scenario record's id for a `run`-originated step record
   * (`kind: "run"`); always `null` for a `do`- or `external`-originated
   * one. */
  scenario_record_id: string | null;
  /** The run's own id (`ScenarioRecord.run_id`) for a `run`-originated step
   * record; always `null` for a `do`- or `external`-originated one, the
   * same split `scenario_record_id` above follows — neither belongs to a
   * scenario or a run. Without this, reading one step record in isolation
   * to find out which run it belongs to meant opening the scenario record
   * next to it; a step record should answer that on its own, since it
   * already answers everything else about what this one execution did. */
  run_id: string | null;
  started_at: string;
  finished_at: string;
  evidence: EvidenceMeta;
  /** Network calls the tool itself saw this execution make, through
   * `ctx.request()` and the page alike — GET/HEAD as reads, everything else
   * as writes. Measured, never declared: this is what run-time keyword
   * enforcement and read-only environments act on (docs/spec.md "Keyword
   * semantics", "Records"). */
  observed: ObservedCounts;
  /** Env var names `ctx.requireEnv` was actually called with during this
   * execution (docs/spec.md "Records"). Present only when non-empty;
   * deduplicated, in read order.
   * Recorded even for a call that throws `MissingEnvError` — measured, not
   * declared, and reading `ctx.env[name]` directly instead leaves no trace
   * here. */
  required_env?: string[];
  /** `ctx.section` calls made during this execution, in call order.
   * Present only when non-empty; a failed step's array still
   * carries whichever labels it reached before failing — that array's last
   * element is "the last stage this execution entered", so there is no
   * separate `error.section` field duplicating the same fact. Only a typed
   * step's `ctx` has `section` — a compat step has no
   * counterpart on `this`, so this field is simply omitted for one, the same
   * way `used` is omitted for a typed step that never calls
   * `ctx.resultOf`. */
  sections?: SectionEntry[];
  /** Every `ctx.call(part, args)` invocation made directly by this
   * execution, in call order (docs/spec.md "Parts") — present only when
   * non-empty, the same convention as `sections`. Depth under this one step
   * record, never a step record of its own: a part that itself calls a part
   * nests inside that entry's own `calls` (`CallEntry`, above) rather than
   * flattening here. Absent for a compat step, which has no `call`
   * counterpart on `this`, the same way `sections`/`polls` already are. */
  calls?: CallEntry[];
  /** Every `ctx.poll` call that finished during this execution, in
   * completion order rather than call order (this file's own header).
   * Present only when non-empty; only a typed
   * step's `ctx` has `poll`, so this field is simply omitted for a compat
   * step, the same way `sections` is. */
  polls?: readonly PollRecord[];
  /** A compat step's own World reads/writes — deduplicated, in access
   * order. Present only when at least one
   * of `reads`/`writes` is non-empty; absent for a typed step (no World),
   * and absent for a compat step that never touched `this` at all. */
  world?: { reads: string[]; writes: string[] };
  /** Attachments/labels/links/parameters/logs this step (or its World
   * channel) declared through the allure-js runtime shim — see this file's
   * own header for how this
   * differs from `evidence`/`observed`. Present only when at least one of
   * its own sub-fields is non-empty. */
  declared?: DeclaredSnapshot;
  /** Console errors, uncaught page errors, and failed requests the browser
   * context saw during this execution (this file's own header) — measured,
   * the same "harness saw it happen" way
   * `observed` is, never declared by the step. Present only when at least
   * one of `console_errors`/`page_errors`/`failed_requests` is non-empty;
   * absent when `ctx.page()` was never called this execution, or was and
   * the page stayed clean. */
  page_events?: PageEventsSnapshot;
  /** How many page-issued requests this execution made were left out of
   * http.jsonl, by resourceType — `{ "image": 34, "stylesheet": 5 }` (this
   * file's own header). Present
   * only when at least one request was left out. */
  http_omitted?: HttpOmittedCounts;
  /** Every Playwright call this step made through `ctx.page()`, read back
   * out of this step's own trace chunk (this file's own header) — `expect`
   * waits included, with their own
   * `ms`. Present only when non-empty; capped at 100 entries, same
   * convention as `page_events`. Omitted, never present-and-empty, when
   * `ctx.page()` was never called this step, when the chunk itself could not
   * be read (a corrupt trace.zip — measurement must never break execution,
   * this file's own header), or when the chunk's own trace format version
   * is one this build does not know how to read (`nuka run`/`nuka do`
   * report that case once, on stderr, instead — src/context/trace-
   * actions.ts's own header). */
  actions?: readonly ActionEntry[];
  /** Present only when `actions` above and/or `evidence.attachments` hit
   * its own 100-entry cap — the true total for whichever of
   * the two was actually truncated, the same `{ category: <true total> }`
   * shape `page_events`'s own `truncated` field already uses, `actions`/
   * `evidence` as this step record's two categories. Built by
   * `mergeTruncated` (src/context/evidence.ts), the one place both sources
   * combine into this single field, so `nuka run`/`nuka do` can never
   * report the two through two different mechanisms. */
  truncated?: { actions?: number; evidence?: number };
  /** This step's own declared `mutates` (`defineStep`'s, default `true`) —
   * the counterpart to `observed` a step record needs to let "declared vs
   * observed" be checked from the step record alone. `null` for a compat
   * step: compat has no
   * `mutates` declaration to
   * report (`then-compat-step`'s own warning exists for exactly this gap), so
   * `null` is a third value, never coerced to `false`. Present on both
   * `StepRecordOk` and `StepRecordFailed` — the declared/observed comparison
   * matters most for a run that actually finished. */
  mutates: boolean | null;
  /** The environment's `version` probe result (docs/spec.md "Records":
   * optional, "(when probed)"). Present only when the environment configures
   * a probe *and* it resolved to a string within its timeout; omitted — not
   * `null` — when there is no probe, it throws, or it times out, since a
   * probe's absence or failure is metadata about the target, never a reason
   * to fail the run itself. */
  target_version?: string;
  /** Every `config.fixtures` entry actually resolved while assembling this
   * step's own bag — src/fixture/resolver.ts's
   * own `resolveFixtures`, called once per step by src/run/run-scenario.ts
   * and src/cli/do.ts alike. Present only when non-empty: a step whose own
   * `run()` destructures only builtins (or none at all) never reaches a
   * user fixture, so this field is simply omitted for one, the same
   * "absence is the normal case" convention `used`/`sections`/`polls`
   * already follow. Builtins themselves never appear here — resolving one
   * is unchanged from before this field existed, and was never measured
   * this way either.
   * `setup_ms`/`at` are present only for an entry this call actually built
   * (`reused: false`); their absence on a `reused: true` entry is what
   * lets a reader tell "reused, hence fast" apart from "measured 0ms" —
   * see `FixtureUsageEntry`'s own doc comment (src/fixture/resolver.ts). */
  fixtures?: FixtureUsageEntry[];
}

export interface StepRecordOk extends StepRecordBase {
  status: "ok";
  /** Passed the step's `returns` schema; this is the trust anchor
   * (docs/spec.md "Records"). */
  result: unknown;
  /** The earlier executions whose validated results this execution actually
   * read from — through a `from` injection or a `ctx.resultOf` call alike
   * (docs/spec.md "Records"). Present only when non-empty;
   * deduplicated by step record id, in read order. `UsedEntry`, not
   * `UsedEntryWithResult`: an "ok" step record's own `used` can never carry
   * the upstream's `result` — the value is already sitting on this step's
   * own `args`/upstream step record, and a construction site that tries to
   * hand a result-bearing entry here fails to compile instead of silently
   * leaking one. */
  used?: UsedEntry[];
}

export interface StepRecordFailed extends StepRecordBase {
  status: "failed";
  /** `message` is unchanged — the human-readable text this step record
   * always had. `kind` is new: a machine-readable
   * classification alongside it, never a replacement for it. */
  error: { message: string; kind: ErrorKind };
  /** Same field as `StepRecordOk.used`, but `UsedEntryWithResult`: a failed
   * step's step record is exactly where a reader most needs "what upstream
   * value did this read", without opening a second record.json — so
   * `result` is required here, not merely allowed. */
  used?: UsedEntryWithResult[];
}

export type StepRecord = StepRecordOk | StepRecordFailed;
