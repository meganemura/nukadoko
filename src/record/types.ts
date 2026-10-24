// Responsibility: the step record shape from docs/spec.md "Records", typed as
// the discriminated union `status` actually implies — `StepRecordPassed` carries
// `result`, `StepRecordFailed` carries `error`, never both.
// `environment` is the environment's own name, plus the optional
// `target_version`. `kind` and
// `scenario_record_id` are widened again now that `nuka run` exists: `kind: "do" | "run"` tells a step record's origin apart — the
// distinction matters for the Allure mapping, per
// docs/spec.md — and `scenario_record_id: string | null` carries the owning
// scenario record's id for a `run`-originated step record, `null` for a
// `do`-originated one.
//
// `"external"` is a third origin that nothing writes any more: a step run
// from inside a Playwright Test spec through `recordStep`, which was
// removed. Such a record stays on disk until retention removes it, so the
// type still names it; its `scenario_record_id`/`run_id` are `null`, as for
// a `"do"` record.
//
// This shape was called `Receipt` before this rename. Step-level and
// scenario-level records both answer the same question, what did this
// execution actually do, but had used two unrelated words for it: `Receipt`
// here, `record` for the scenario level (src/record/scenario-record.ts). One
// purpose, two vocabularies. The old name also carried little of that
// meaning on its own: a receipt, in the everyday sense, is proof a
// transaction happened, not a record of what happened during one. What the
// old name actually carried was never the name itself: it was the fact that
// `StepRecordPassed.result` had passed the step's own `returns` schema. That
// fact does not move when the name does, so this rename costs a reader
// nothing they depended on.
//
// `observed` is what the tool itself measured this execution reaching,
// never what a step declared. It is required on both `StepRecordPassed`
// and `StepRecordFailed`, and each channel in it is `null` when the
// execution never reached that channel: "nothing was measured" and
// "measured zero" are different facts, and a step that called `fetch`
// must not read as having made no requests.
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
// file, is worth the duplication. The entry is always that object. A bare
// step-record id string is not a shape this field reads.
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
// (`status: "passed"`) while the page underneath it was throwing the whole time,
// and before this field that fact left no trace on the step record at all.
// Measured by `PageEventsCollector` (src/context/page-events.ts), which also
// documents *why* each category is shaped the way it is (console limited to
// `error`, `weberror` never carrying `Error#stack`, the 100-entries-per-
// category cap reported through the sibling `truncated` field rather than by
// changing a category's own type). Present on both
// `StepRecordPassed` and `StepRecordFailed` alike, and independent of `status`:
// a page error is evidence about the page, not a verdict on the step. The
// whole field, and each of its three categories individually, is omitted
// when empty — `sections`/`used`/`declared`'s own convention — so a step
// that never called `ctx.page()`, or did and the page stayed clean, carries
// no `page_events` key at all.
//
// `error.kind` and `mutates` let a report classify a failure without parsing
// `error.message` (free text meant for humans) and check a step's declared
// `mutates` against what it actually did without a second lookup. `ErrorKind` is a
// closed enum on purpose — an open string would grow one value per step and
// stop being usable as a classifier — and only the first four values name a
// failure the contract layer itself can point at; every other throw is `"step_error"`, the deliberate
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
// `{ "image": 34, "stylesheet": 5, "script": 12 }`. Present only when at least one request was left out,
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
// `ScenarioEvidence` in src/record/scenario-record.ts). Parsing lives in
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
// `ScenarioRecord.teardown_errors` (src/record/scenario-record.ts) instead, the
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

import type { SCHEMA_VERSIONS } from "./schema-version.js";
import type { DeclaredSnapshot } from "../compat/declared.js";

/** Dropped-request counts by Playwright's own `request.resourceType()`
 * (`"image"`, `"stylesheet"`, `"script"`, ...) — the step record's own
 * `http_omitted` shape, e.g. `{ "image": 34, "stylesheet": 5 }`. */
export interface HttpOmittedCounts {
  [resourceType: string]: number;
}

/** What one step boundary reached (`nuka do`'s whole execution, or one
 * `nuka run` pickle step). Mirrors the step record's own `observed` shape
 * (docs/spec.md "Records"). The name is older than the shape: it holds
 * the measurements themselves, not only counts, and it stays because the
 * package exports it. */
export interface ObservedCounts {
  /** Every child process `runCommand` started during this execution, in
   * call order (docs/spec.md "Records"). `null` when the execution never
   * called `runCommand`. */
  processes: ProcessEntry[] | null;
  /** How many requests the step's own process sent through `fetch`,
   * `node:http`, `node:https`, or a Playwright request context, each one
   * a line of the step's http.jsonl. `null` when it sent none. A page's
   * own traffic is not counted: it is in the trace. */
  http: number | null;
  /** The files the step changed: its scratch directories compared before
   * and after the step, and every `node:fs` write its own process made
   * anywhere outside the state directory. `null` when it changed none. */
  files: FileChange[] | null;
  /** What the step did that nukadoko could not measure. Empty when there
   * was nothing. */
  unmeasured: UnmeasuredEntry[];
  /** The lines of the world's `program.log` that carry this step's trace
   * context (docs/spec.md "Program"). `null` for a world at a `url`,
   * whose log nukadoko does not read. Absent when the run has no world
   * URL. */
  program_log?: ProgramLogSlice | null;
}

/** A step's slice of the program's log (docs/spec.md "Trace context and
 * the program's log"). */
export interface ProgramLogSlice {
  /** The step's trace id: every request it sent to the world carries it
   * in its `traceparent`, and so does every line of the program's log
   * that belongs to the step. */
  readonly trace_id: string;
  /** How many lines of `program.log` carried the step's trace id when its
   * record was written. 0 when the program does not tag its lines, or
   * wrote them later (`program-log-late.txt`). */
  readonly lines: number;
  /** The file beside the step record that holds those lines, redacted;
   * `null` when there are none. */
  readonly file: string | null;
  /** How many requests the step sent to the world with a `traceparent`. */
  readonly stamped: number;
  /** The step's lines came to more than 16 MiB, so the file holds the
   * lines up to that size and `lines` counts them all. */
  readonly truncated?: true;
}

/** A body or a file's content, kept as text. The bytes are decoded as
 * UTF-8, redacted, and then cut, so a secret that the cut would split is
 * already replaced. */
export interface KeptText {
  /** The text, redacted. Absent when the bytes are not UTF-8 text
   * (`binary`) or were not read (`unread`). */
  readonly text?: string;
  /** The whole size in bytes, before redaction. Absent when nukadoko
   * stopped reading before the end (`bytes_read`) or did not read it
   * (`unread`). */
  readonly bytes?: number;
  /** A body nukadoko stopped reading before its end, or one that ended
   * with an error: the bytes it read, at the cap, when nukadoko stopped
   * waiting (`incomplete`), or when the body failed (`error`). The body
   * is at least this long; its whole size was never seen. */
  readonly bytes_read?: number;
  /** `text` holds only the start. */
  readonly truncated?: true;
  /** The bytes are not UTF-8 text, so none is kept. */
  readonly binary?: true;
  /** The body had not ended when nukadoko stopped waiting for it, at the
   * step boundary or at the run's end (an event stream, for example). */
  readonly incomplete?: true;
  /** The body ended with an error, an abort, or a close before its end
   * that nukadoko did not cause: the first line of what happened. */
  readonly error?: string;
  /** Why nukadoko did not read the body at all. */
  readonly unread?: string;
}

/** One path the step changed. A directory's path ends in `/` and has no
 * `bytes`; a removed path has neither `bytes` nor `content`. */
export interface FileChange {
  /** The absolute path. */
  readonly path: string;
  readonly change: "added" | "changed" | "removed";
  /** The file's size after the step. */
  readonly bytes?: number;
  /** The file's content after the step, within the per-file and per-step
   * caps. */
  readonly content?: KeptText;
}

/** One action nukadoko saw the step take and could not measure. */
export interface UnmeasuredEntry {
  /** `child_process`: a process started without `runCommand`.
   * `worker_thread`: a `worker_threads.Worker`, whose own globals no
   * patch reaches. `socket`: a connection that carries no recorded HTTP
   * request (one the step opened, or one opened before the step that the
   * step wrote to), or what an upgraded connection or a CONNECT tunnel
   * carried after its recorded handshake. `files`: a scratch directory
   * that could not be compared, a path the step wrote whose identity
   * could not be read, or a step past the path limit. */
  readonly kind: "child_process" | "worker_thread" | "socket" | "files";
  /** One line that names it: the program and its argument count (never
   * its arguments), the script, the address or URL, or the directory and
   * why. */
  readonly detail: string;
}

/** Where one args key's value came from. `capture`, `docstring`, and
 * `table` are the feature line's own; `from` names the step record and
 * the result key it was read from; `command_line` is `nuka do --args`;
 * `schema` is the step's args schema producing a key nothing gave (a
 * default, or a transform). */
export type ArgOrigin =
  | "capture"
  | "docstring"
  | "table"
  | "command_line"
  | "schema"
  | { readonly from: { readonly step_record_id: string; readonly step: string; readonly key: string } };

/** One recorded environment value. The text itself only when it cannot
 * be a credential: an absolute path, a decimal integer, or `true` or
 * `false`, with secrets redacted. Any other value is its UTF-8 length. */
export type EnvValue = string | { readonly hidden_bytes: number };

/** The environment a process got, against the runner's own. Every name is
 * recorded; a value only as an {@link EnvValue}. `inherited` when the step
 * passed no `env`. */
export type ProcessEnv =
  | { readonly inherited: true }
  | {
      readonly added: Readonly<Record<string, EnvValue>>;
      readonly changed: Readonly<Record<string, EnvValue>>;
      readonly removed: readonly string[];
    };

/** One process `runCommand` ran. Measured by the helper itself, never
 * declared by the step. */
export interface ProcessEntry {
  /** The program and its arguments, exactly as `runCommand` passed them to
   * the operating system: an array, so no quoting rule has to be guessed. */
  readonly command: readonly string[];
  /** The absolute working directory the process ran in. */
  readonly cwd: string;
  /** The exit code, or `null` when a signal ended the process. */
  readonly exit_code: number | null;
  /** The signal that ended the process. Present only when one did. */
  readonly signal?: string;
  /** `true` when `runCommand`'s own `timeout` stopped the process. Present
   * only then. */
  readonly timed_out?: true;
  readonly duration_ms: number;
  /** What changed under `cwd` between the spawn and the close. Present
   * only for a process run inside a step. */
  readonly files?: ProcessFiles;
  /** The file, in the step record's evidence directory, that holds what
   * the process wrote to stdout, redacted. Present only when it wrote
   * something and the execution had an evidence directory. */
  readonly stdout?: string;
  /** The same, for stderr. */
  readonly stderr?: string;
  /** The same, for the `input` the step wrote to the process's stdin. */
  readonly stdin?: string;
  /** The environment the process got, against the runner's. Present for
   * every process this release's `runCommand` ran. */
  readonly env?: ProcessEnv;
}

/** What a process wrote, decoded as UTF-8, handed to the collector beside
 * its entry so the collector can keep it as evidence files. */
export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** What the step wrote to stdin, redacted. Absent when it wrote
   * nothing. */
  readonly stdin?: string;
}

/** Paths relative to the process's `cwd`, `/`-separated, a directory's
 * ending in `/`, each list sorted. `skipped` names the `node_modules`
 * and `.git` directories that were not walked. `unmeasured` says why
 * nothing was compared (too many entries, or an unreadable directory). */
export type ProcessFiles =
  | {
      readonly added: readonly string[];
      readonly changed: readonly string[];
      readonly removed: readonly string[];
      readonly skipped?: readonly string[];
    }
  | { readonly unmeasured: string };

/** One `console.error` call, error type only (warning is excluded as
 * noise). */
export interface ConsoleErrorEntry {
  readonly text: string;
  readonly location: {
    readonly url: string;
    readonly lineNumber: number;
    readonly columnNumber: number;
  };
  readonly at: string;
  /** The `pageAs(name)` context this came from (docs/spec.md "Context
   * API"). Absent for the default context, the one `page` belongs to. */
  readonly as?: string;
}

/** One uncaught error the page itself threw (`BrowserContext`'s own
 * `weberror`, the context-level counterpart to `Page`'s `pageerror`). Never
 * carries `Error#stack` — see src/context/page-events.ts's own header for why. */
export interface PageErrorEntry {
  readonly message: string;
  readonly at: string;
  /** The `pageAs(name)` context this came from (docs/spec.md "Context
   * API"). Absent for the default context, the one `page` belongs to. */
  readonly as?: string;
}

/** One request the page issued that failed at the network level (DNS,
 * connection refused, aborted, ...) — never a completed response with a
 * non-2xx status, which Playwright's own `requestfailed` event does not fire
 * for either. */
export interface FailedRequestEntry {
  readonly method: string;
  readonly url: string;
  /** `request.failure()?.errorText` — omitted on the rare occasion
   * `failure()` itself returns `null` for a `requestfailed` event (nothing
   * else to report in that case). */
  readonly failure?: string;
  readonly at: string;
  /** The `pageAs(name)` context this came from (docs/spec.md "Context
   * API"). Absent for the default context, the one `page` belongs to. */
  readonly as?: string;
}

/** Which of `page_events`'s three categories were truncated, each mapped to
 * its *true* total (how many were actually recorded), never to the number
 * of entries the step record shows (always <= src/context/page-events.ts's `MAX_ENTRIES_PER_CATEGORY`).
 * Present on the snapshot only when at least one category was truncated —
 * a category that was not is simply absent here,
 * never present with its own entry count or `false`. */
export interface PageEventsTruncated {
  console_errors?: number;
  page_errors?: number;
  failed_requests?: number;
}

/** The step record's own `page_events` shape (docs/spec.md "Records") —
 * each category is always a bare array (never the truncated entry count, and
 * never conditionally shaped some other way; see src/context/page-events.ts's own header),
 * present only when at least one entry of that kind was recorded. `truncated`
 * is the one place a cap being hit is reported.
 * The whole field is omitted from the step record when all three categories
 * are empty (same convention as `declared`/`sections`/`used`). */
export interface PageEventsSnapshot {
  console_errors?: readonly ConsoleErrorEntry[];
  page_errors?: readonly PageErrorEntry[];
  failed_requests?: readonly FailedRequestEntry[];
  truncated?: PageEventsTruncated;
}

/** One Playwright call this step made, read out of its own trace chunk
 * (docs/spec.md "Records"). `params` beyond the five below are never
 * carried onto the step record (src/context/trace-actions.ts's own header, allowlist reasoning) —
 * `setContent`'s own HTML body is the case that motivated it: a value that
 * can run to kilobytes, next to nothing a reader needs that trace.zip
 * doesn't already have in full. */
export interface ActionEntry {
  /** The Playwright call's own method name (`"expect"`, `"goto"`, `"click"`,
   * `"setContent"`, ...) — trace's own `before.method`, unmodified. */
  readonly method: string;
  /** `before.params.expression` (an `expect` call's own matcher name, e.g.
   * `"to.be.visible"`) when the call carried one. */
  readonly expression?: string;
  /** `before.params.selector` when the call carried one. */
  readonly selector?: string;
  /** `before.params.url` when the call carried one (a `goto`, for one). */
  readonly url?: string;
  /** `before.params.isNot` (an `expect` call's own `.not`) when the call
   * carried one. */
  readonly is_not?: boolean;
  /** `before.params.timeout` (the call's own declared timeout, in ms) when
   * the call carried one. */
  readonly timeout_ms?: number;
  /** `after.endTime - before.startTime`, rounded to the nearest
   * millisecond — the call's own duration, on the trace's own clock. */
  readonly ms: number;
  /** `"failed"` when the trace's own `after` entry carried an `error`,
   * `"passed"` otherwise. */
  readonly outcome: "passed" | "failed";
  /** ISO 8601, converted from the trace's own monotonic clock via the
   * header's `wallTime`/`monotonicTime` pair (src/context/trace-actions.ts's own header) — the
   * same absolute timeline `sections`/`polls`/`evidence.screenshots[].at`
   * already share. */
  readonly at: string;
  /** The `pageAs(name)` context this came from (docs/spec.md "Context
   * API"). Absent for the default context, the one `page` belongs to. */
  readonly as?: string;
}

export interface UsedEntry {
  readonly step_record_id: string;
  readonly step: string;
  /** Exclusion marker, not a real field (see src/context/used.ts's header) — always
   * absent on an actual `UsedEntry`. Its only job is to make a
   * result-bearing `UsedEntryWithResult` fail to structurally satisfy
   * `UsedEntry` wherever an array of it is expected, so a step-record-
   * construction site that forgets to call `omitUsedResults` before handing
   * a "passed" step record its `used` array gets a compile error instead of a
   * silent leak. */
  readonly result?: never;
}

/** `UsedEntry` with its exclusion marker replaced by a real, required
 * `result` — the upstream step record's full validated result. `Omit` first
 * (rather than intersecting `UsedEntry` directly with `{ result: unknown }`)
 * because `result?: never` intersected with `result: unknown` collapses to
 * `result: never`, an uninhabitable field; `Omit` removes the marker before
 * `unknown` replaces it, so this type is actually constructible. */
export type UsedEntryWithResult = Omit<UsedEntry, "result"> & {
  readonly result: unknown;
};

/** Every fixture actually resolved while assembling one step's bag —
 * step-record-facing (docs/spec.md "Records").
 * Includes every `config.fixtures` entry touched, not only the names the
 * step itself destructured: a fixture built as a side effect of resolving
 * another one is real, measured setup cost, and hiding it would make
 * `setup_ms`'s own absence unreadable: normally its absence already has to
 * mean either "this call reused an existing instance" or "this fixture is
 * simply fast", and a hidden, transitively-built dependency would add a
 * third, indistinguishable reading ("a dependency nobody told you about")
 * to those same two. Builtins
 * never appear here — they are not `config.fixtures` entries, and their own
 * resolution is unchanged, already unmeasured the same way it always was. */
export interface FixtureUsageEntry {
  readonly name: string;
  readonly scope: FixtureScope;
  /** Present only when this call actually built the fixture (`reused:
   * false`) — omitted, not `0`, for a reused instance, so a reader can
   * tell "this call built it in Nms" from "this call didn't build it at
   * all" without a sentinel value. */
  readonly setup_ms?: number;
  /** ISO 8601, the moment this call's own build started — same presence
   * rule as `setup_ms`. */
  readonly at?: string;
  /** `true` when this fixture was already built (by an earlier step in
   * this scenario, or — for `scope: "process"` — by an earlier scenario in
   * this same `nuka run` invocation) and this call simply received the
   * cached value. */
  readonly reused: boolean;
}

/** `"scenario"` (default) rebuilds per scenario (or per `nuka do`
 * execution) and tears down at that scenario's own end; `"process"` builds
 * once per process — the first time any step that process runs names it (or
 * its own dependents do) — and tears down once, after every scenario that
 * process ran has finished. Under `nuka do` the two collapse to the same
 * single-execution lifetime.
 *
 * `"worker"` is deliberately not a member: `nuka run --concurrency <n>`
 * runs scenarios in `n` worker processes, and a worker *is* a process, so
 * `"process"` already names one worker. A separate `"worker"` scope would
 * be a synonym with nothing left for it to mean on its own.
 *
 * `"process"` names one address space, not one `nuka run` invocation: a
 * fixture's own value is a plain JS object and cannot cross into another
 * process, so this scope can only ever mean "once per process" no matter
 * how many times anything is invoked against it. At `--concurrency 1` one
 * invocation is one process, so the two happen to coincide; at
 * `--concurrency <n>` the same invocation is `n` processes, and this scope
 * builds the fixture `n` times, once per worker, never once for the whole
 * invocation. Something that has to happen exactly once in the world, no
 * matter how many processes ever run against it — seeding a database,
 * running a migration, starting a mock server that owns a port — does not
 * belong in a `"process"`-scope fixture: run more than one process and it
 * happens again. */
export type FixtureScope = "scenario" | "process";

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
 *   - `timeout` — a deadline fired before the step or hook settled: a typed
 *     step's `stepTimeout` (twenty minutes by default) or its own
 *     `defineStep({ timeout })`, or a compat step's/hook's own `{ timeout }`
 *     (or the run's `setDefaultTimeout`).
 *   - `unsupported` — a compat-only shape nukadoko doesn't implement: a
 *     `done()`-callback arity, or a `"pending"`/`"skipped"` return value.
 *   - `claim_broken`: a claim step read its values and at least one of its
 *     claims did not hold: the one kind that is a criterion failing.
 *   - `unobserved`: a claim step's `observe` threw, so it read nothing
 *     and no claim was judged. A deadline that passes first is `timeout`,
 *     and a fixture that fails to set up is `step_error`, as for any step.
 *   - `claim_unjudged`: a claim step read its values, and nukadoko failed
 *     while judging a claim, so that claim neither held nor broke. A failure
 *     of the judging is never the criterion failing, nor the step not
 *     having measured.
 *   - `step_error` — anything else: the step's/hook's own code threw. Also
 *     the default whenever classification is uncertain. */
export type ErrorKind =
  | "args_invalid"
  | "result_invalid"
  | "binding_invalid"
  | "world_invalid"
  | "timeout"
  | "unsupported"
  | "claim_broken"
  | "unobserved"
  | "claim_unjudged"
  | "step_error";

/** How a claim compares its actual value with its expected value
 * (docs/spec.md "Claims"). */
export type ClaimCompare =
  | "equal"
  | "not-equal"
  | "contains-text"
  | "has-item"
  | "matches"
  | "greater-than"
  | "at-least"
  | "less-than"
  | "at-most";

/** How a claim normalizes its actual value before `at` and the compare. */
export type ClaimView = "text" | "lines" | "json";

/** `held` and `broken` are the two outcomes of a comparison. `unobserved`
 * when the step read no values, so nothing was judged; `unjudged` when the
 * step read its values and nukadoko failed while judging this claim. */
export type ClaimOutcome = "held" | "broken" | "unobserved" | "unjudged";

/** A recorded channel whose content equals a claim's raw actual value, or
 * an expected value an earlier step returned or `observe` read:
 * `channel` is a path inside that step record, such as
 * `observed.processes[0].stdout`, `observed.processes[0].exit_code`,
 * `http.jsonl[1].response_body`, `http.jsonl[1].status`, or
 * `observed.files[0].content`. Information about where the value came
 * from, never a condition of the claim. */
export interface MeasuredChannel {
  readonly step_record_id: string;
  readonly channel: string;
}

/** One comparison as the step judged it. `actual` is the value after
 * `view` and `at`, absent when that path held nothing (then `reason` says
 * which). `*_from` names where each side came from, `view` and `at`
 * included: `sentence:<key>`, `from:<step>@<line or step record id>.<path>`,
 * `literal:<the pattern words that state it>`, or `observe:<path>`.
 * `expected_text` is the text the sentence states the expected value as:
 * a capture's text, the docstring, the table, or the pattern words of a
 * literal, and `null` for a value from an earlier step or from `observe`.
 * `reason` is present only when the claim broke for something other than
 * the comparison itself: an undefined value, a value that is not plain
 * JSON, two JSON types, an empty expected value, a side compared with
 * itself, or, for an `unjudged` claim, the failure. `expected_measured`
 * is the channel that holds an expected value an earlier step returned or
 * `observe` read (`null` when none does), and absent for any other
 * expected value and for an item's comparison inside an `each`, whose
 * declaration carries it. */
export interface ClaimComparisonRecord {
  readonly actual?: unknown;
  readonly actual_from: string;
  readonly view?: ClaimView;
  readonly at?: string;
  readonly compare: ClaimCompare;
  readonly expected?: unknown;
  readonly expected_from: string;
  readonly expected_view?: ClaimView;
  readonly expected_text: string | null;
  readonly expected_measured?: MeasuredChannel | null;
  readonly outcome: ClaimOutcome;
  readonly reason?: string;
}

/** One claim of an `each`, as declared, with the expected value it read:
 * the same for every item, since an expected value never reads the item.
 * `actual` is the path inside an item, absent for the item itself. */
export interface ClaimItemDeclaration {
  readonly actual?: string;
  readonly view?: ClaimView;
  readonly at?: string;
  readonly compare: ClaimCompare;
  readonly expected?: unknown;
  readonly expected_from: string;
  readonly expected_view?: ClaimView;
  readonly expected_text: string | null;
  /** As on a comparison: the channel that holds an expected value an
   * earlier step returned or `observe` read, `null` when none does. */
  readonly expected_measured?: MeasuredChannel | null;
}

/** One item of an `each`: whether `where` selected it, the `where`
 * comparisons that decided it, and, for a selected item, its claims. */
export type ClaimItemRecord =
  | {
      readonly index: number;
      readonly selected: true;
      readonly where?: readonly ClaimComparisonRecord[];
      readonly outcome: "held" | "broken" | "unjudged";
      readonly claims: readonly ClaimComparisonRecord[];
    }
  | {
      readonly index: number;
      readonly selected: false;
      readonly where: readonly ClaimComparisonRecord[];
    };

/** A claim over every item of an array, or every item `where` selects.
 * `where` and `claims` are the item claims as declared. `items` is the
 * array's length and `selected` how many items the claims applied to.
 * `results` holds at most 20 items: the broken ones first, then the ones
 * `where` left out, then the ones that held, in index order, and
 * `results_truncated` is then the number of items in the array. */
export interface ClaimEachRecord {
  readonly actual_from: string;
  readonly view?: ClaimView;
  readonly at?: string;
  readonly each: {
    readonly where?: readonly ClaimItemDeclaration[];
    readonly claims: readonly ClaimItemDeclaration[];
    readonly items: number;
    readonly selected: number;
    readonly results: readonly ClaimItemRecord[];
    readonly results_truncated?: number;
  };
  readonly outcome: ClaimOutcome;
  readonly reason?: string;
}

/** What one side of one claim read on one reading of a polled claim step:
 * the value (the raw actual value, or the expected value it was compared
 * with), the start of that value's JSON and its size when the JSON is
 * longer than `CLAIM_READING_MAX_BYTES`, or why it had no value. */
export type ClaimReadingValue =
  | { readonly value: unknown }
  | { readonly json_start: string; readonly json_bytes: number }
  | { readonly reason: string };

/** One reading of a polled claim step: its number among the step's
 * readings, when it happened, whether every claim held on it, and either
 * what each claim read (`actuals`, in claim order, and `expecteds` too
 * when an expected value comes from `observe`) or the first line of the
 * error `observe` threw. */
export interface ClaimReading {
  readonly attempt: number;
  readonly at: string;
  readonly held: boolean;
  readonly actuals?: readonly ClaimReadingValue[];
  readonly expecteds?: readonly ClaimReadingValue[];
  readonly error?: string;
}

/** A claim as the step record carries it (docs/spec.md "Claims"):
 * a comparison, or a claim over each item of an array, with the channel
 * the raw actual value was measured on. */
export type ClaimRecord = (ClaimComparisonRecord | ClaimEachRecord) & {
  readonly measured: MeasuredChannel | null;
};

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
   * `ScenarioEvidence.dir`: `"final.png"` for the default context, and
   * `"final.<name>.png"` for each `pageAs(name)` context. */
  readonly file: string;
  /** ISO 8601 — the moment `page.screenshot()` resolved (src/context/
   * browser-evidence.ts's `finalize`), not when the file finished writing or
   * when `finalize` itself was called. */
  readonly at: string;
  /** The `pageAs(name)` context this came from (docs/spec.md "Context
   * API"). Absent for the default context, the one `page` belongs to. */
  readonly as?: string;
}

/** The trace chunk one `pageAs(name)` context wrote for one step or hook
 * boundary. The default context's chunk stays on `trace`, so a reader that
 * only knows `trace` still finds it. */
export interface NamedTraceEntry {
  readonly as: string;
  /** Relative to the same directory `trace` is relative to. */
  readonly file: string;
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
   * ".nukadoko/runs/run-.../steps/step-..." for a run, ".nukadoko/do/step-..."
   * for `nuka do`). */
  dir: string;
  /** Present only when the default context (the one `page` belongs to)
   * recorded a chunk. */
  trace?: string;
  /** One entry per `pageAs(name)` context that recorded a chunk, in the
   * order the contexts opened. Present only when non-empty. */
  named_traces?: readonly NamedTraceEntry[];
  /** Screenshots actually written; empty when no browser was used. One
   * entry per browser context: `final.png` for the default context, then
   * `final.<name>.png` for each `pageAs(name)` context, whatever the
   * outcome. */
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
  /** Absolute paths of the directories the `scratch` fixture created during
   * this execution, in creation order. Present only when non-empty. The
   * directories are removed when the scenario ends (for `nuka do`, when the
   * execution ends), so a path
   * here tells a reader where the step worked, not a file that still
   * exists. */
  scratch?: readonly string[];
}

// Exported by name: `StepRecordPassed` and `StepRecordFailed` extend it, and a
// surface that publishes those two without publishing this name leaks the
// shared fields as an anonymous type.
export interface StepRecordBase {
  /** `SCHEMA_VERSIONS.step_record` (src/record/schema-version.ts). A record
   * without it was written by nukadoko 0.16.1 or earlier. */
  schema_version: typeof SCHEMA_VERSIONS.step_record;
  /** The version of nukadoko that wrote this record. */
  nukadoko: string;
  step_record_id: string;
  step: string;
  /** `"do"` for a `nuka do` execution, `"run"` for one step inside a `nuka
   * run` scenario (docs/spec.md "Records": "the same shape whether the step
   * ran inside a scenario or via `do`"), `"external"` on a record the removed
   * `recordStep` wrote, still on disk until retention removes it. */
  kind: "do" | "run" | "external";
  /** Exactly what `--args` deserialized to (`do`) or what the pickle step's
   * captures/table/docstring bound (`run`) — unvalidated and uncoerced by
   * the step's own `args` schema either way. */
  args: unknown;
  /** The `--env` name this run targeted; `"default"` when `--env` was
   * omitted. Not a special value in the schema sense — docs/spec.md
   * "Environments and secrets": default is just the name of an
   * environment that may or may not itself be configured. */
  environment: string;
  /** The world this step ran against (run.json's `worlds[].name`), or
   * `null` when the tree has no program file and no world ran. Not the
   * compat World a step reads and writes, which is `world`. Absent on a
   * record an earlier build wrote. */
  world_name?: string | null;
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
  /** Where each args key's value came from. Present for a typed step;
   * absent for a compat step, whose arguments are positional. */
  args_origin?: Readonly<Record<string, ArgOrigin>>;
  /** What the execution reached outside its own code: processes, HTTP,
   * files, and what could not be measured. Measured, never declared, and
   * never a verdict: Then position and read-only environments act on the
   * declared `mutates` (docs/spec.md "Keyword semantics", "Records"). */
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
  /** How many http.jsonl lines this execution could not append (a missing
   * directory, a full disk, a permission error), so a request the step
   * sent may be absent from the file. Present only when at least one
   * append failed. */
  http_log_failed?: number;
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
  /** This step's own declared `mutates` (`defineStep`'s, default `true`),
   * beside `observed` so a reader can set the declaration against what
   * was measured from the step record alone. `null` for a compat
   * step: compat has no
   * `mutates` declaration to
   * report (`then-compat-step`'s own warning exists for exactly this gap), so
   * `null` is a third value, never coerced to `false`. Present on both
   * `StepRecordPassed` and `StepRecordFailed` — the declared/observed comparison
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
  /** A claim step only (docs/spec.md "Claims"): each claim in the order
   * the step declares it, with what it compared and how it ended. */
  claims?: ClaimRecord[];
  /** A claim step only: `observed` when the step read the values its
   * claims compare, `unobserved` when it read none (its `observe` threw or
   * ran past the deadline, or a fixture it names could not be set up); the
   * step's `error.kind` then says which. */
  observation?: "observed" | "unobserved";
  /** A claim step only: how many times the step read those values. Each
   * `observe` call counts; a step with no `observe` reads its `from`
   * values once. */
  attempts?: number;
  /** A polled claim step only: its readings, oldest first; `attempt`
   * says where a gap falls. Every reading of a short poll, and of a long
   * one the first, the last, and the readings whose value changed
   * (`CLAIM_READINGS_CAP` in src/step/evaluate-claims.ts). `poll` reads
   * until every claim holds, so how many times `observe` is called tells
   * it whether a reading held; what each reading read shows a value that
   * walked toward the expected one. */
  readings?: ClaimReading[];
  /** A polled claim step whose record left readings out: how many, and
   * how many of them were change points (0 when every change point is in
   * `readings`). */
  readings_left_out?: { readings: number; change_points: number };
}

export interface StepRecordPassed extends StepRecordBase {
  status: "passed";
  /** Passed the step's `returns` schema; this is the trust anchor
   * (docs/spec.md "Records"). */
  result: unknown;
  /** The earlier executions whose validated results this execution actually
   * read from — through a `from` injection or a `ctx.resultOf` call alike
   * (docs/spec.md "Records"). Present only when non-empty;
   * deduplicated by step record id, in read order. `UsedEntry`, not
   * `UsedEntryWithResult`: a "passed" step record's own `used` can never carry
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
  /** Same field as `StepRecordPassed.used`, but `UsedEntryWithResult`: a failed
   * step's step record is exactly where a reader most needs "what upstream
   * value did this read", without opening a second record.json — so
   * `result` is required here, not merely allowed. */
  used?: UsedEntryWithResult[];
}

export type StepRecord = StepRecordPassed | StepRecordFailed;
