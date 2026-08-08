import { existsSync } from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type Page } from "playwright";
import type { z } from "zod";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext, StepFixtures } from "../context.js";
import type { PollRecord, ScreenshotEntry, SectionEntry } from "../receipt/types.js";
import type { SecretSet } from "../secrets/types.js";
import type { Step } from "../step/define-step.js";
import type { StorageState } from "../session/storage-state.js";
import { launchBrowserWithTracing, type BrowserEvidenceHandle } from "./browser-evidence.js";
import { createEnvReadsCollector } from "./env-reads.js";
import { MissingEnvError, UnregisteredStepError } from "./errors.js";
import { createEvidenceCollector, type EvidenceSnapshot } from "./evidence.js";
import { wrapRequestContextWithLogging } from "./http-log.js";
import { createHttpOmittedCollector, type HttpOmittedCounts } from "./http-omitted.js";
import { createObservedCollector, type ObservedCounts } from "./observed.js";
import { createPageEventsCollector, type PageEventsSnapshot } from "./page-events.js";
import { pollWithRecording, type PollOptions } from "./poll.js";
import { createPollsCollector } from "./polls.js";
import { createSectionsCollector } from "./sections.js";
import { createUsedCollector, type UsedEntryWithResult } from "./used.js";

// Responsibility: assemble the real StepContext a `do`/`run` execution builds
// a typed step's fixture bag from (`buildStepFixtures`, p4a-fixture-bag task
// spec, below) — env, baseURL (also wired into the browser
// context so `page.goto("/path")` resolves against it), lazy browser, lazy
// logged HTTP context — plus a `dispose` the executor calls *after* `run`
// returns, never itself reachable from `ctx`. `ctx.section` and `ctx.poll`
// are both assembled here for the same reason (t3-sections task spec,
// decision 4; ctx-poll-receipt task spec): each only writes into a
// collector below (`sections`, `polls` — same shape as `observed`/`used`),
// so the read side (`sectionsSnapshot()`/`pollsSnapshot()`) and the reset
// (`beginStep`) stay executor-only, the same trust-model rule as everything
// else on this handle — a step can write a label or run a poll but can
// never read back or clear what it or an earlier step already wrote.
// `poll`'s own retry loop still lives entirely in src/context/poll.ts
// (`pollWithRecording`, unchanged in its own right) — this module only owns
// the `polls` collector and binds the two together to produce `ctx.poll`.
// docs/spec.md's Context API boundary rule (`ctx` carries only what the
// executor must inject) is the whole point: docs/spec.md's trust model
// requires that a step cannot control its own receipt or evidence
// collection, so nothing evidence-related is exposed on the object passed
// into `run`; only the executor (src/cli/do.ts), which never hands
// `dispose` onward, can call it.
// The same split applies to sessions: this module restores a loaded
// storageState into whichever context(s) a step opens and hands back
// whichever one *should* be persisted, but never writes it to disk itself —
// that stays the executor's job too (this task's spec, item 2).
//
// `nuka run` shares one `ctx` across every step of a pickle (docs/spec.md
// "Running": "Steps in one pickle share one context"), but each step's
// http.jsonl still belongs to that step's own receipt dir, while a browser's
// trace/screenshots belong to the scenario as a whole (m1-run task spec,
// decision 5). `beginStep` on the handle (never on `ctx` itself — sink
// switching stays executor-only, same rule as `dispose`) is the minimal seam
// that split needs: `evidenceDir` still anchors the browser's trace/
// screenshots for this ctx's whole lifetime, while the http log's directory
// is a separate, mutable pointer the executor advances at each step
// boundary. `nuka do` never calls `beginStep`, so its behavior — one fixed
// dir for both, one observed tally spanning the whole execution — is
// unchanged.
//
// `beginStep` also resets the `observed` tally (m2pre-observed task spec,
// decision 2): the http.jsonl sink and the observed collector share one
// step-boundary concept, so one call advances both rather than risking a
// caller that redirects the log dir but forgets to reset the tally (or vice
// versa). The collector itself is created once, here, and handed to both
// http-log.ts's wrapper and browser-evidence.ts's launch — the one object
// every network path this ctx opens tallies into, never exposed on `ctx`
// (same trust-model rule as `dispose`/`beginStep`: a step cannot see or
// reset its own observation).
//
// `beginStep` resets `sections` the same way (t3-sections task spec,
// decision 4): `nuka run` shares one `ctx`, hence one `sections` collector,
// across every step of a pickle, so without this reset a later step's
// receipt would start out already carrying whichever labels an earlier
// step called `ctx.section` with — the same bleed-across-steps bug this
// reset already prevents for `observed`/`used`.
//
// `beginStep` resets `polls` the same way (ctx-poll-receipt task spec): one
// `ctx.poll` collector per `ctx`, shared across every step of a pickle just
// like `sections`, so without this reset a later step's receipt would start
// out already carrying whichever polls an earlier step made — the same
// bleed-across-steps bug this reset already prevents for
// `observed`/`used`/`sections`.
//
// `beginStep` resets `pageEvents` the same way again (P0-page-events task
// spec): one collector per `ctx`, created once here and handed to
// browser-evidence.ts's launch the same way `observed` is, so a later
// step's receipt does not inherit console/uncaught/failed-request evidence
// an earlier step's page already produced. The context's own `console`/
// `weberror`/`requestfailed` subscriptions (browser-evidence.ts) are set up
// once, at context creation, and outlive every reset — `nuka do` never
// calls `beginStep` at all, so its single collector simply accumulates for
// the execution's whole lifetime, the same as `observed`'s.
//
// `beginStep` resets `httpOmitted` the same way again (p3b-page-network
// task spec, scope item 2): one collector per `ctx`, created once here and
// handed to browser-evidence.ts's launch the same way `observed`/
// `pageEvents` already are, so a later step's receipt does not inherit an
// earlier step's own dropped-asset counts. `ctx.page()`'s own launch call
// (below) also now hands the browser launcher this ctx's current
// `httpLogDir`/`secrets` — the same two values `ctx.request()` already
// reads at call time — so page-issued document/xhr/fetch traffic lands on
// the very same http.jsonl `ctx.request()` writes to, redacted the same
// single way, rather than a second file or a second redaction pass.
//
// `env` arrives already loaded and merged (m1-secrets task spec, decision
// 2): the executor is the one place that knows the full envFiles list *and*
// which of them are secret sources, so it loads env and builds the run's
// SecretSet itself, once, and hands both down — this module never reads an
// envFile and never decides what is secret. `secrets` only ever reaches
// http-log.ts's redaction; nothing here exposes it on `ctx`, matching
// docs/spec.md "Secrets": redaction is applied by the executor, never
// controllable from a step's `run`.
//
// `resultOf` (m2pre-resultof task spec, decisions 1-2): the *lookup* — "does
// this Step object have a most-recent successful result, and under which
// receipt id" — is the executor's own knowledge (run-scenario.ts's chain, or
// `nuka do`'s always-`undefined` reader), passed in here as `options.resultOf`
// and never computed by this module. What this module owns is the *wrapper*:
// `ctx.resultOf` calls that lookup and, only when it actually returns a
// value, records the receipt id (and the step name that receipt records —
// m6a-from-core task spec, item 5) on the `used` collector below — the same
// "step cannot see or reset its own observation" trust rule as `observed`,
// applied to provenance instead of network calls. `usedSnapshot()` (the
// handle's read side) and `beginStep`'s reset mirror `observedCounts()`/its
// own reset exactly, for the same reason: one step boundary, two tallies.
//
// `isRegisteredStep` (m6a-from-core task spec, item 6): before even
// attempting the lookup above, `ctx.resultOf` now checks that `step` is one
// discovery actually registered — the executor's own knowledge again (built
// from whichever vocabulary it already has: run-scenario.ts's per-pickle
// `vocabulary` option, or `nuka do`'s own single lookup), passed in here the
// same way `resultOf`'s reader is, and defaulting to "everything is
// registered" so a caller that doesn't care about this contract (most of
// this file's own tests) doesn't have to say so. A `Step` this predicate
// rejects throws `UnregisteredStepError` (src/context/errors.ts) rather than
// silently returning `undefined` forever — the mistake docs/spec.md
// "Chaining steps" describes: a step file reached through a second, separate
// `await import()` produces a distinct object that can never match anything
// in the vocabulary. `recordUsed` (the handle's own executor-only write side,
// below) exists for the *other* way a receipt becomes provenance: a `from`
// injection (run-scenario.ts) reads the exact same per-pickle chain
// `resultOf`'s own reader does, but from outside any step's `run()` — before
// it is even called — so it cannot go through the `ctx.resultOf` wrapper at
// all; `recordUsed` lets it write into the very same `used` collector
// instead of needing a second one, which is what keeps a step that is both
// injected into *and* itself calls `ctx.resultOf` for a different upstream
// down to one deduplicated list rather than two.
//
// `requireEnv` records the name it was given on the `envReads` collector
// below *before* throwing `MissingEnvError` (env-reads-and-mutates-doc task
// spec, item A) — a step whose execution failed for a missing key still
// gets a receipt showing what it asked for, which matters most exactly
// when a step fails this way. Only `requireEnv` writes to this collector:
// a step that reads `ctx.env[name]` directly never passes through any call
// this module owns, so that read leaves no trace here, on purpose (same
// spec, scope: no `ctx.env` Proxy). Same lifetime and reset rule as
// `used`/`sections` — one collector per ctx, zeroed by `beginStep`.
//
// `beginStep` now also carries a chunk title, and `endStep` is new (p3a-
// trace-per-step task spec): the Playwright trace used to be one recording
// for this whole ctx's lifetime; it is now one chunk per *trace-recorded
// boundary*, opened lazily on that boundary's own first `ctx.page()` call
// and closed right after that boundary's own execution finishes — before
// its receipt/hook record is built, so `evidence.trace`/`ScenarioHookRecord.
// trace` can say whether that boundary's own chunk actually exists.
// `pendingChunkTitle`/`pendingChunkFileName`/`chunkOpen` below are the
// bookkeeping that makes that lazy-open-eager-close shape work without a
// step or hook ever seeing it: `endStep` is called once per boundary
// (run-scenario.ts, right after that boundary's own step/hook call returns
// or throws, before its own record is written), and `dispose` calls the
// same `closeCurrentChunk` helper as a catch-all, which is the *only*
// closing point `nuka do` ever reaches (it never calls `beginStep`/
// `endStep` at all — one execution is one chunk, per this task's spec item
// 4, titled from `CreateStepContextOptions.stepTitle` rather than from any
// `beginStep` call).
//
// A `beginStep` call with no `title` disables chunk-opening entirely until
// the next titled call — the general escape hatch a caller with nothing
// worth tracing can use. Before p3d-hook-trace, run-scenario.ts's own
// Before/After/AfterStep boundaries always took that path: hooks were kept
// out of p3a-trace-per-step's own scope on purpose, so `ctx.page()` during a
// hook still worked, it just produced no trace chunk of its own. p3d-
// hook-trace closes that gap — a hook boundary now gets a real `title` (and
// its own `chunkFileName`, below) for every individual Before/After/
// AfterStep *invocation*, not once per phase, so each hook call that
// actually touches the browser gets a trace/`actions` of its own, isolated
// from its sibling hooks and from every step's own chunk. A hook boundary
// that never calls `ctx.page()` still opens nothing, the same lazy rule a
// step already follows (below) — `title`/`chunkFileName` being set is not
// itself enough to open a chunk, only a first `ctx.page()` call is.
//
// `pendingChunkFileName` (p3d-hook-trace task spec) is the second half of
// that same per-boundary state, alongside `pendingChunkTitle` — needed
// because a step's own chunk always writes to `"trace.zip"` inside that
// step's own receipt dir (a directory no other chunk ever shares), while
// several hook invocations can share one scenario evidence dir (a scenario
// can register more than one Before/After hook, and AfterStep runs once per
// executed step), so `"trace.zip"` alone would let a later hook invocation
// silently overwrite an earlier one's file. `beginStep`'s own `chunkFileName`
// parameter defaults to `"trace.zip"` when omitted, so every step call site
// (and `nuka do`, via `CreateStepContextOptions.stepTitle`) is unaffected;
// only run-scenario.ts's own hook call sites ever pass a different name.
//
// A step (or hook boundary) that never calls `ctx.page()` never opens a
// chunk at all — `chunkOpen` stays `false` end to end — so `endStep` has
// nothing to close and that boundary's own `trace` field is correctly
// absent (this task's spec: "ブラウザに触れない step には chunk が無い",
// extended by p3d-hook-trace to "ブラウザに触れない hook には chunk を作ら
// ない").
//
// `buildStepFixtures` (below, p4a-fixture-bag task spec) is this module's
// second export now, alongside `createStepContext` — a typed step no longer
// receives the `StepContext` this file still builds; it receives a
// `StepFixtures` bag resolved from exactly the names its own `run` function
// destructures (src/step/fixture-names.ts). `createStepContext`'s own
// `ctx` is unchanged and still the thing this file hands to
// `buildStepFixtures`, to compat's World (untouched, `src/compat/**`), and
// to `run-scenario.ts`'s own `from` injection — only a typed step's `run`
// call site (run-scenario.ts, cli/do.ts) now goes through the bag first.
// The lazy-launch rule moves with it: `ctx.page()`'s own memoized-launch
// branches (above) are unchanged, but the *caller* that used to be a
// step's own body calling `ctx.page()` whenever it felt like it is now
// exactly one call, from `buildStepFixtures`, made once per step boundary
// and only when `page` (or `context`, which needs the same browser) is
// among the destructured names — so "a step that never names `page` never
// launches a browser" is now a fact about bag construction, not merely
// about what a step's body happened to call this run. Both of `ctx.page()`
// own branches (fresh launch vs. an already-running browser opening this
// boundary's own chunk) stay reachable and necessary: a multi-step pickle
// still calls `buildStepFixtures` once per step, and the second step's own
// call reaches the second branch exactly as a step's own direct
// `ctx.page()` call used to.

export interface EvidenceResult {
  trace?: string;
  screenshots: ScreenshotEntry[];
  http?: string;
}

export interface DisposeResult {
  evidence: EvidenceResult;
  /** The storageState the executor should persist for this run's
   * `--session`, or `undefined` when there is nothing to persist — either
   * because neither `ctx.page()` nor `ctx.request()` was ever called this
   * run, or because collecting it failed (see browser-evidence.ts's
   * `collectStorageState`). `undefined` must not be read as "clear the
   * session": the executor's own contract (this task's spec, item 2) is to
   * leave an existing session file untouched when this is `undefined`. */
  storageState: StorageState | undefined;
  /** The engine and version this execution actually launched (p6-browser-
   * type task spec), lifted straight from `browserHandle.browserInfo`
   * (browser-evidence.ts) — measured, never `config.browserType` itself.
   * `undefined` whenever `ctx.page()` was never called this ctx's lifetime,
   * the same "no browser, no field" convention `evidence.trace` already
   * follows: run-scenario.ts only sets `ScenarioRecord.browser` when this is
   * present. */
  browser?: { readonly type: string; readonly version: string };
}

export interface StepContextHandle {
  ctx: StepContext;
  /** Closes whatever this execution opened (browser, request context),
   * reports which evidence files it actually produced (docs/spec.md
   * "Receipts": only files that exist), and hands back the storageState (if
   * any) the executor should persist for this run's session. Takes no
   * `status` (fb4-evidence-time task spec, item 1): its only past use was
   * passing it on to `browserHandle.finalize`, which no longer takes one
   * either — see browser-evidence.ts's own header for why keeping an unused
   * `status` parameter here would itself be a misleading residue, implying
   * evidence still varies by outcome when it no longer does. */
  dispose(): Promise<DisposeResult>;
  /** Executor-only: the network calls tallied since the current step
   * boundary began (this execution's whole lifetime for `nuka do`, since
   * `nuka run` since the last `beginStep`) — GET/HEAD as reads, anything
   * else as writes, through `ctx.request()` and the page alike (m2pre-
   * observed task spec, decisions 1-2). Never exposed on `ctx`. */
  observedCounts(): ObservedCounts;
  /** Executor-only: every receipt this execution actually read a value from
   * since the current step boundary began — through `ctx.resultOf` or a
   * `from` injection alike (m2pre-resultof task spec, decision 2; m6a-from-
   * core task spec, item 5) — deduplicated by receipt id, in read order.
   * Never exposed on `ctx` — same rule as `observedCounts()`. */
  usedSnapshot(): UsedEntryWithResult[];
  /** Executor-only: records one provenance read the same `used` collector
   * `ctx.resultOf`'s own wrapper writes into, for a read that happens
   * *outside* `ctx.resultOf` entirely — a `from` injection (m6a-from-core
   * task spec, items 4-5), which fills an args key before the step's `run()`
   * is ever called, so there is no `ctx.resultOf` call for it to ride along
   * with. Never exposed on `ctx`; only the executor (run-scenario.ts) calls
   * this, immediately after actually reading the value it names. `result`
   * (fb3-used-result task spec) is the upstream's own full validated result
   * — carried the same way `ctx.resultOf`'s own wrapper below already does. */
  recordUsed(receiptId: string, stepName: string, result: unknown): void;
  /** Executor-only: the `ctx.section` calls made since the current step
   * boundary began, in call order (t3-sections task spec, decisions 1-2;
   * `at` added by fb4-evidence-time task spec, item 3). Never exposed on
   * `ctx` — same rule as `observedCounts()`/`usedSnapshot()`. */
  sectionsSnapshot(): SectionEntry[];
  /** Executor-only: every `ctx.poll` call that finished since the current
   * step boundary began, in completion order (ctx-poll-receipt task spec).
   * Never exposed on `ctx` — same rule as `observedCounts()`/
   * `sectionsSnapshot()`. */
  pollsSnapshot(): PollRecord[];
  /** Executor-only: the names `ctx.requireEnv` was called with since the
   * current step boundary began, deduplicated, in read order — recorded
   * even for a call that went on to throw `MissingEnvError` (env-reads-and-
   * mutates-doc task spec, item A). Never exposed on `ctx` — same rule as
   * `observedCounts()`/`usedSnapshot()`/`sectionsSnapshot()`. */
  envReadsSnapshot(): string[];
  /** Executor-only: console errors, uncaught page errors, and failed
   * requests the browser context saw since the current step boundary began
   * (P0-page-events task spec), or `undefined` when none of the three
   * happened at all — whether because `ctx.page()` was never called this
   * step, or because it was and the page simply stayed clean. Never exposed
   * on `ctx` — same rule as `observedCounts()`/`sectionsSnapshot()`/
   * `pollsSnapshot()`. */
  pageEventsSnapshot(): PageEventsSnapshot | undefined;
  /** Executor-only: how many page-issued requests since the current step
   * boundary began were left out of http.jsonl, by resourceType (p3b-page-
   * network task spec, scope item 2), or `undefined` when nothing was ever
   * left out this step — whether because `ctx.page()` was never called, or
   * because every request it made was a document/xhr/fetch and none were
   * dropped. Never exposed on `ctx` — same rule as
   * `observedCounts()`/`pageEventsSnapshot()`. */
  httpOmittedSnapshot(): HttpOmittedCounts | undefined;
  /** Executor-only (P9 task spec): every `ctx.evidence.attach`/`.path`
   * result confirmed to exist since the current step boundary began — see
   * src/context/evidence.ts's own `EvidenceCollector.snapshot` doc comment.
   * `async`, unlike every other snapshot on this handle, because confirming
   * a `path()`-allocated file's existence needs a filesystem read. Never
   * exposed on `ctx` — same rule as `observedCounts()`/`sectionsSnapshot()`. */
  evidenceSnapshot(): Promise<EvidenceSnapshot>;
  /** Executor-only: advances to the next step boundary — redirects where the
   * *next* `ctx.request()` call logs to (http.jsonl), without disturbing an
   * already-memoized request context's cookies, and resets the `observed`
   * tally, the `used` log, the `sections` log, the `polls` log, the
   * `required_env` log, the `pageEvents` log, and the `httpOmitted` tally to
   * empty. `nuka run`'s executor calls this once per step, right before
   * running it, so a pickle's shared ctx still logs and tallies each step's
   * own network calls, provenance reads, section labels, finished polls,
   * required env names, and page-origin evidence under that step's own
   * receipt dir (m1-run task spec, decision 5; m2pre-observed task spec,
   * decision 2; t3-sections task spec, decision 4; ctx-poll-receipt task
   * spec; env-reads-and-mutates-doc task spec, item A; P0-page-events task
   * spec). Also closes whatever trace chunk the *previous* boundary had open
   * (this file's own header, p3a-trace-per-step task spec) and, when `title`
   * is given, remembers it (and `chunkFileName`) as the new boundary's own
   * chunk title/output file for the next `ctx.page()` call to open lazily.
   * `title` is `undefined` for a boundary with nothing worth tracing, which
   * disables chunk-opening for that boundary entirely — see this file's own
   * header. Since p3d-hook-trace, run-scenario.ts's own Before/After/
   * AfterStep boundaries pass a real `title` (and `chunkFileName`) for every
   * individual hook invocation, the same as a step already does; only a
   * caller that genuinely wants no chunk at all leaves `title` unset now.
   * `chunkFileName` defaults to `"trace.zip"` when omitted (this file's own
   * header) — a step call site never needs to pass one; a hook call site
   * always does, since several hook invocations can share one scenario
   * evidence dir. Never exposed on `ctx` — same executor-only rule as
   * `dispose`. */
  beginStep(dir: string, title?: string, chunkFileName?: string): Promise<void>;
  /** Executor-only (p3a-trace-per-step task spec, extended by p3d-hook-trace
   * to hook boundaries too): closes the current boundary's own trace chunk,
   * if one is open, writing it to the current boundary's own directory (the
   * `dir` its own `beginStep` call was given, joined with `chunkFileName`)
   * *before* that step's receipt (or that hook invocation's own record) is
   * built — the reason this exists as its own call rather than folding into
   * the *next* `beginStep` (this file's own header: a receipt/record is
   * built and written well before the next boundary's `beginStep` ever
   * runs, so waiting for that call would mean `trace` could never
   * truthfully be set on the receipt/record that chunk actually belongs
   * to). A no-op when no chunk is open (no browser was ever launched this
   * boundary, or this ctx has no browser handle at all). Never exposed on
   * `ctx`. */
  endStep(): Promise<void>;
}

export interface CreateStepContextOptions {
  config: NukadokoConfig;
  /** Absolute path to this execution's browser evidence directory (trace.zip,
   * screenshots) and, until `beginStep` first moves it, http.jsonl too; must
   * already exist. */
  evidenceDir: string;
  /** `ctx.env`'s value, already loaded and merged by the executor from every
   * configured envFile (this task's spec, decision 2) — this module never
   * reads an envFile itself, so a run's env files are parsed exactly once no
   * matter how many contexts get created from them. */
  env: Readonly<Record<string, string>>;
  /** Values this run's HTTP log (http.jsonl) must redact; defaults to empty
   * when there is nothing secret to log. Never exposed on `ctx` — only
   * `wrapRequestContextWithLogging` (http-log.ts) sees it. */
  secrets?: SecretSet;
  /** A `--session`'s previously saved storageState, when one was loaded and
   * parsed successfully; `undefined` for a session's first-ever use or when
   * `--session` wasn't given. Restored into whichever of `ctx.page()` /
   * `ctx.request()` the step actually opens — never both eagerly, since
   * neither is created until first use. */
  storageState?: StorageState;
  /** Looks up `step`'s most recent successful result by object identity
   * (m2pre-resultof task spec, decision 1) — the executor's own connection
   * to `ctx.resultOf`. Defaults to a reader that always returns `undefined`,
   * matching `nuka do`'s contract (docs/spec.md "Context API": "undefined
   * under `nuka do`") without every caller that doesn't care about chaining
   * having to say so. `nuka run`'s executor (run-scenario.ts) passes one
   * backed by the current pickle's own chain instead. `stepName` (m6a-from-
   * core task spec, item 5) is the step name that receipt itself records —
   * carried alongside `receiptId` so `used` can cite it without a second
   * lookup, per docs/spec.md "Receipts": each `used` entry is
   * `{ "receipt": ..., "step": ... }`. */
  resultOf?: (step: Step) => { result: unknown; receiptId: string; stepName: string } | undefined;
  /** Whether `step` is one discovery actually registered (m6a-from-core task
   * spec, item 6) — checked by `ctx.resultOf` before even attempting the
   * `resultOf` lookup above; a `Step` this rejects throws
   * `UnregisteredStepError` instead of the lookup running at all. Defaults to
   * "everything is registered" (`() => true`), matching this option's own
   * `resultOf` default of "nothing is ever readable": a caller that doesn't
   * wire this in gets today's old, permissive behavior rather than a
   * surprise new throw. `nuka run`'s executor (run-scenario.ts) and `nuka
   * do`'s (cli/do.ts) both build this from the same vocabulary they already
   * discovered. */
  isRegisteredStep?: (step: Step) => boolean;
  /** This ctx's own trace chunk title, for a caller that never calls
   * `beginStep` at all (p3a-trace-per-step task spec) — `nuka do`'s own
   * "one execution is one chunk" shape (this task's spec, item 4: "`nuka
   * do` では step 名"), where the step's name is known once, here, and
   * never needs to change again. `undefined` when omitted: no chunk opens
   * until some `title` is set, whether from here or from a later
   * `beginStep(dir, title)` call. `nuka run`'s executor (run-scenario.ts)
   * leaves this unset — its very first `beginStep` call (before any Before
   * hook) always runs before any step or hook code does, so whatever this
   * option would have held is overwritten before it could matter. */
  stepTitle?: string;
}

export function createStepContext(options: CreateStepContextOptions): StepContextHandle {
  const {
    config,
    evidenceDir,
    env,
    secrets = [],
    storageState,
    resultOf: readResultOf = () => undefined,
    isRegisteredStep = () => true,
  } = options;
  // Mutable, unlike browser evidence's fixed `evidenceDir`: `beginStep`
  // (below) is the only way this ever changes, and `do` never calls it, so
  // `do`'s http.jsonl stays exactly where it always has.
  let httpLogDir = evidenceDir;
  // This boundary's own trace chunk title (p3a-trace-per-step task spec) —
  // `undefined` means no chunk should open for this boundary at all (before
  // any `stepTitle`/`beginStep` has ever set one, or a boundary that
  // deliberately wants no chunk). `ctx.page()` reads this lazily, on its own
  // first call within a boundary; `beginStep` is the only thing that ever
  // changes it.
  let pendingChunkTitle: string | undefined = options.stepTitle;
  // This boundary's own chunk output file name, relative to `httpLogDir`
  // (p3d-hook-trace task spec) — always `"trace.zip"` until a hook boundary
  // (run-scenario.ts) names its own, since several hook invocations can
  // share one scenario evidence dir where a step's own chunk never shares
  // its receipt dir with anything else (this file's own header). Only
  // meaningful when `pendingChunkTitle !== undefined`; `beginStep` is the
  // only thing that ever changes it.
  let pendingChunkFileName = "trace.zip";
  // Whether a chunk is currently open for the *current* boundary — reset to
  // `false` by `closeCurrentChunk` (never set back to `false` anywhere
  // else), and only ever `true` between a successful `ctx.page()`-triggered
  // `beginStepChunk` and the next `closeCurrentChunk` call.
  let chunkOpen = false;
  // One collector for this ctx's whole lifetime; `beginStep` resets its
  // *counts*, never replaces the object itself, so every network path
  // opened before or after a reset still tallies into the same instance.
  const observed = createObservedCollector();
  // Same lifetime rule as `observed`, for provenance instead of network
  // calls (m2pre-resultof task spec, decision 2).
  const used = createUsedCollector();
  // Same lifetime rule again, for `ctx.section`'s call log (t3-sections
  // task spec, decision 4).
  const sections = createSectionsCollector();
  // Same lifetime rule again, for `ctx.poll`'s own finished-call log
  // (ctx-poll-receipt task spec).
  const polls = createPollsCollector();
  // Same lifetime rule again, for `ctx.requireEnv`'s name log (env-reads-
  // and-mutates-doc task spec, item A).
  const envReads = createEnvReadsCollector();
  // Same lifetime rule again, for console errors/uncaught page errors/
  // failed requests the browser context saw (P0-page-events task spec) —
  // created once, handed to browser-evidence.ts's launch below, and only
  // ever populated if `ctx.page()` is actually called this ctx's lifetime.
  const pageEvents = createPageEventsCollector();
  // Same lifetime rule again, for page-issued requests left out of
  // http.jsonl (p3b-page-network task spec, scope item 2) — created once,
  // handed to browser-evidence.ts's launch below, and only ever populated
  // if `ctx.page()` is actually called this ctx's lifetime.
  const httpOmitted = createHttpOmittedCollector();
  // Same lifetime rule again, for `ctx.evidence.attach`/`.path` (P9 task
  // spec) — `() => httpLogDir` is the exact same moving-pointer getter
  // `ctx.request()`'s own http.jsonl logging already reads (this file's own
  // header): `beginStep` below redirects both at once, so an attachment
  // always lands beside that step's own http.jsonl, trace.zip, and
  // final.png, never in a stale directory.
  const evidence = createEvidenceCollector(() => httpLogDir);

  let browserHandle: BrowserEvidenceHandle | undefined;
  let requestContext: APIRequestContext | undefined;

  // Closes whatever trace chunk is open for the *current* boundary, writing
  // it to `httpLogDir` (this file's own header) — a no-op when nothing is
  // open, covering both "no browser was ever launched this ctx's lifetime"
  // and "this boundary never called `ctx.page()`" without either caller
  // needing to tell the two apart. Called from three places: `beginStep`
  // (closing the *previous* boundary's own chunk — defense-in-depth only,
  // since normal operation always closes a step's own chunk via `endStep`
  // before the next `beginStep` runs), `endStep` itself, and `dispose` (the
  // only closing point `nuka do` ever reaches, since it never calls either
  // of the other two).
  //
  // Also flushes page-http-log.ts's own pending http.jsonl writes now (p3b-
  // page-network task spec) — whenever a browser exists at all, not only
  // when `chunkOpen`: a boundary with no `pendingChunkTitle` (or one that
  // never called `ctx.page()`) never opens a chunk (this file's own header)
  // but can still have produced page-issued http.jsonl entries this
  // boundary needs finished before anything downstream reads that file.
  // Ordered before the chunk close below, though the order between the two
  // does not itself matter — both are cheap, and neither depends on the
  // other having run.
  async function closeCurrentChunk(): Promise<void> {
    if (!browserHandle) {
      return;
    }
    await browserHandle.flushPageHttpLog();
    if (!chunkOpen) {
      return;
    }
    chunkOpen = false;
    await browserHandle.endStepChunk(path.join(httpLogDir, pendingChunkFileName));
  }

  const ctx: StepContext = {
    env,
    requireEnv(name: string): string {
      // Recorded first, before the presence check below can throw (env-
      // reads-and-mutates-doc task spec, item A): a run that fails for a
      // missing key still gets a receipt showing what it asked for, and
      // this is the one call site the library controls, so a name recorded
      // here is a real measurement, not a claim. Name only, never the
      // value — a value can be a secret.
      envReads.record(name);
      const value = env[name];
      // Empty string is "not set", same reasoning as MissingEnvError's own
      // doc comment: an envFile's `KEY=` line parses to `""`, not "omitted",
      // so treating `""` as present here would defeat the whole point of a
      // presence check.
      if (value === undefined || value === "") {
        throw new MissingEnvError(name);
      }
      return value;
    },
    baseURL: config.baseURL,
    async page(): Promise<Page> {
      if (!browserHandle) {
        browserHandle = await launchBrowserWithTracing({
          // `config.browserType` (p6-browser-type task spec) — which of
          // chromium/firefox/webkit to launch; `undefined` behaves like
          // `"chromium"` (browser-evidence.ts's own default).
          browserType: config.browserType,
          browser: config.browser,
          // `config.browserContext` (context-options task spec) — schema.ts
          // already rejects a `browserContext` that sets `baseURL`/
          // `storageState`, so the two args below can never collide with
          // it; browser-evidence.ts still spreads them in last anyway.
          browserContext: config.browserContext,
          evidenceDir,
          storageState,
          observed,
          pageEvents,
          // Same getter/secrets pair `ctx.request()` (below) already reads
          // at call time — page-issued traffic lands on the very same
          // http.jsonl, redacted the very same way (this file's own header,
          // p3b-page-network task spec).
          logPath: () => path.join(httpLogDir, "http.jsonl"),
          secrets,
          httpOmitted,
          baseURL: config.baseURL,
        });
        // Opens this boundary's own chunk right at launch (this file's own
        // header: "起動した時点で「今の step」の chunk を開き始める") when a
        // title is already pending — `undefined` here means a boundary with
        // nothing worth tracing (a caller with no `stepTitle` that also
        // never calls `beginStep` before its first `ctx.page()`), which
        // simply gets a browser with no chunk at all, on purpose.
        if (pendingChunkTitle !== undefined) {
          await browserHandle.beginStepChunk(pendingChunkTitle);
          chunkOpen = true;
        }
      } else if (!chunkOpen && pendingChunkTitle !== undefined) {
        // The browser was already running (an earlier step or hook launched
        // it) but this boundary has not opened its own chunk yet — this is
        // that boundary's own first `ctx.page()` call, so start one now,
        // same as the fresh-launch branch above.
        await browserHandle.beginStepChunk(pendingChunkTitle);
        chunkOpen = true;
      }
      return browserHandle.page;
    },
    async request(): Promise<APIRequestContext> {
      if (!requestContext) {
        // No `baseURL` requirement here, matching `ctx.page()` above, which
        // already passes `config.baseURL` through as `undefined` without
        // complaint (baseurl-and-chaining-doc task spec, item A) — a suite
        // that only ever talks to absolute URLs across several hosts has no
        // single baseURL to state, and forcing one into config would make
        // config assert something untrue. If a step written against a
        // relative path actually needs a baseURL and none was configured,
        // Playwright's own `newContext`/fetch call fails on that URL; this
        // module does not duplicate Playwright's URL-resolution rules to
        // pre-empt that with its own error.
        //
        // `config.requestContext` (context-options task spec) is spread in
        // first, `baseURL`/`storageState` after: schema.ts already rejects
        // a `requestContext` that sets either key, so this ordering never
        // actually resolves a real collision, only guards the invariant.
        const raw = await playwrightRequest.newContext({
          ...(config.requestContext ?? {}),
          ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          ...(storageState ? { storageState } : {}),
        });
        requestContext = wrapRequestContextWithLogging(
          raw,
          () => path.join(httpLogDir, "http.jsonl"),
          secrets,
          observed,
        );
      }
      return requestContext;
    },
    resultOf<S extends Step>(step: S) {
      // Checked before the lookup even runs (m6a-from-core task spec, item
      // 6): a Step object discovery never registered has nothing legitimate
      // to look up at all, and silently returning `undefined` for it (the
      // pre-this-task behavior) is indistinguishable from "registered, just
      // hasn't run yet" — exactly the mistake this throw exists to surface
      // instead (see UnregisteredStepError's own doc comment).
      if (!isRegisteredStep(step)) {
        throw new UnregisteredStepError();
      }
      const entry = readResultOf(step);
      if (entry === undefined) {
        return undefined;
      }
      // Recorded only on an actual read (m2pre-resultof task spec, decision
      // 2: omit when empty — a call that returned `undefined` leaves no
      // trace). `entry.result` is carried alongside (fb3-used-result task
      // spec) the same way a `from` injection's own `recordUsed` call does.
      used.record(entry.receiptId, entry.stepName, entry.result);
      return entry.result as z.infer<S["returns"]>;
    },
    section(label: string): void {
      sections.record(label);
    },
    poll<T>(fn: () => Promise<T | undefined>, options: PollOptions = {}): Promise<T> {
      return pollWithRecording(fn, options, (finished) => {
        polls.record({
          ...(options.description !== undefined ? { description: options.description } : {}),
          at: finished.at,
          attempts: finished.attempts,
          waited_ms: finished.waitedMs,
          outcome: finished.outcome,
        });
      });
    },
    // P9 task spec: `attach`/`path` handed straight through from the
    // collector above — this object literal is what both `StepContext.
    // evidence` and (via `buildStepFixtures`, below) `StepFixtures.evidence`
    // actually are; `snapshot`/`reset` are deliberately left off, the same
    // executor-only rule every other collector on this file already follows.
    evidence: { attach: evidence.attach, path: evidence.path },
  };

  async function dispose(): Promise<DisposeResult> {
    const evidence: EvidenceResult = { screenshots: [] };
    let browserStorageState: StorageState | undefined;
    let requestStorageState: StorageState | undefined;

    if (browserHandle) {
      // Must run before finalize() below: finalize() closes the context,
      // and storageState() can only succeed on one that's still open (see
      // browser-evidence.ts's collectStorageState doc comment).
      browserStorageState = await browserHandle.collectStorageState();
      // Closes whatever chunk the *current* boundary still has open (this
      // file's own header) — the only closing point `nuka do` ever reaches
      // (it calls neither `beginStep` nor `endStep`), and, for `nuka run`, a
      // defense-in-depth no-op: every step's and hook's own chunk is already
      // closed by its own `endStep()` call well before `dispose()` ever
      // runs. Must run before finalize() below for the same reason
      // `collectStorageState` above does — `endStepChunk` needs a
      // still-open context.
      await closeCurrentChunk();
      evidence.screenshots = await browserHandle.finalize();
      // Only claim the chunk file exists if `closeCurrentChunk` actually got
      // to write it: `endStepChunk` swallows its own failure (the browser/
      // context can be gone by the time it runs), so this must be checked
      // the same way http.jsonl is below rather than assumed (docs/spec.md
      // "Receipts": evidence lists only files that exist). `httpLogDir`/
      // `pendingChunkFileName`, not `evidenceDir`/`"trace.zip"`: the same
      // directory and file name `closeCurrentChunk` just wrote to, which for
      // `nuka run`'s own scenario-level `dispose()` this field is not
      // actually read from (run-scenario.ts builds `ScenarioRecord.evidence`
      // from `screenshots` alone) — kept accurate anyway, since `nuka do`'s
      // own receipt does read it, and `pendingChunkFileName` stays
      // `"trace.zip"` for `nuka do` regardless (it never calls `beginStep`).
      if (existsSync(path.join(httpLogDir, pendingChunkFileName))) {
        evidence.trace = pendingChunkFileName;
      }
    }

    if (requestContext) {
      try {
        // Collected before dispose() below for the same reason as the
        // browser context above, though request contexts don't actually
        // close their cookie jar on dispose() the way a browser context
        // does — kept symmetric with the browser path regardless.
        requestStorageState = await requestContext.storageState();
      } catch {
        // A step can dispose its own request context before returning;
        // losing this snapshot must not block teardown below, nor cost the
        // receipt (see DisposeResult's doc comment: `undefined` here means
        // "leave the existing session file untouched", never "clear it").
      }
      try {
        await requestContext.dispose();
      } catch {
        // As with browser teardown above, losing the request context's own
        // dispose() is not a reason to lose the receipt; http.jsonl is
        // written incrementally as calls happen, so it is unaffected by a
        // dispose() failure here.
      }
    }

    // Checked unconditionally, not only when `requestContext` was opened
    // (p3b-page-network task spec): http.jsonl can now exist from
    // `ctx.page()`'s own document/xhr/fetch traffic alone, with
    // `ctx.request()` never called at all — gating this on `requestContext`
    // would leave `evidence.http` `undefined` for exactly that run even
    // though the file it names is sitting right there. Reflects whichever
    // directory is *current* at dispose time. For `do` that is always
    // `evidenceDir` (it never calls `beginStep`); for `nuka run`, dispose()
    // only ever runs once, at the whole scenario's end, so this field is not
    // what a step's own receipt relies on — the executor checks each step's
    // own receipt dir directly, right after that step finishes, before the
    // log dir advances again.
    if (existsSync(path.join(httpLogDir, "http.jsonl"))) {
      evidence.http = "http.jsonl";
    }

    // Browser wins whenever one was opened, whether or not a request
    // context was *also* opened (this task's spec, decision 3): it carries
    // cookies + localStorage where the request context only carries
    // cookies, and Playwright's two cookie jars are independent, so merging
    // them would synthesize a state that never actually existed. This also
    // covers the case where `browserStorageState` itself is `undefined`
    // (collection failed) — falling back to the request context's value
    // there would contradict "collection failing means skip the save, keep
    // the existing file" (this task's spec, decision 2).
    const storageStateToPersist = browserHandle ? browserStorageState : requestStorageState;

    return {
      evidence,
      storageState: storageStateToPersist,
      // Measured, not declared (DisposeResult's own doc comment) — absent
      // whenever no browser was ever launched this ctx's lifetime, same
      // "no browser, no field" rule `evidence.trace` already follows.
      ...(browserHandle ? { browser: browserHandle.browserInfo } : {}),
    };
  }

  function observedCounts(): ObservedCounts {
    return observed.snapshot();
  }

  function usedSnapshot(): UsedEntryWithResult[] {
    return used.snapshot();
  }

  function recordUsed(receiptId: string, stepName: string, result: unknown): void {
    used.record(receiptId, stepName, result);
  }

  function sectionsSnapshot(): SectionEntry[] {
    return sections.snapshot();
  }

  function pollsSnapshot(): PollRecord[] {
    return polls.snapshot();
  }

  function envReadsSnapshot(): string[] {
    return envReads.snapshot();
  }

  function pageEventsSnapshot(): PageEventsSnapshot | undefined {
    return pageEvents.snapshot();
  }

  function httpOmittedSnapshot(): HttpOmittedCounts | undefined {
    return httpOmitted.snapshot();
  }

  async function evidenceSnapshot(): Promise<EvidenceSnapshot> {
    return evidence.snapshot();
  }

  async function beginStep(dir: string, title?: string, chunkFileName?: string): Promise<void> {
    // Closes the *previous* boundary's own chunk before this boundary's own
    // `httpLogDir`/`pendingChunkTitle`/`pendingChunkFileName` overwrite the
    // state that closing needs (this file's own header) — a no-op in normal
    // operation, since `endStep()` already closed the previous boundary's
    // own chunk before this ever runs; real insurance only for a boundary
    // that somehow left one open.
    await closeCurrentChunk();
    httpLogDir = dir;
    pendingChunkTitle = title;
    pendingChunkFileName = chunkFileName ?? "trace.zip";
    observed.reset();
    used.reset();
    sections.reset();
    polls.reset();
    envReads.reset();
    pageEvents.reset();
    httpOmitted.reset();
    evidence.reset();
  }

  async function endStep(): Promise<void> {
    await closeCurrentChunk();
  }

  return {
    ctx,
    dispose,
    observedCounts,
    usedSnapshot,
    recordUsed,
    sectionsSnapshot,
    pollsSnapshot,
    envReadsSnapshot,
    pageEventsSnapshot,
    httpOmittedSnapshot,
    evidenceSnapshot,
    beginStep,
    endStep,
  };
}

/**
 * Resolves `names` (a typed step's own `fixtureParameterNames(step.run)`,
 * src/step/fixture-names.ts) into a `StepFixtures` bag, reading each named
 * fixture off `ctx` (this file's own `createStepContext` output) — the
 * "build only what was named" half of p4a-fixture-bag task spec's design:
 * a step's requested names are closed over the reachable part of the
 * fixture graph and built in topological order, so a fixture nothing
 * reaches is never built. `page`/`context` are the only two names that can
 * cause a browser to launch (`context` is `page`'s own `.context()` — never
 * a second browser, never a second `ctx.page()` call site of its own): a
 * step whose `run` destructures neither never calls `ctx.page()` at all, so
 * this function itself is the one place "a step that doesn't name `page`
 * doesn't launch a browser" actually happens, not merely something the
 * fixture's own laziness makes true incidentally.
 *
 * `names` is trusted to already be validated (src/step/validate-
 * fixtures.ts, run before execution in `nuka check`/`nuka run`/`nuka do`'s
 * own setup phase) — every name in it is one of `StepFixtures`'s own
 * members. The `default` branch below is defense-in-depth only: it should
 * be unreachable in practice, and throwing plainly (not silently building a
 * bag missing a key) is what CLAUDE.md's "nothing breaks silently" asks
 * for if that assumption is ever wrong.
 */
export async function buildStepFixtures(
  ctx: StepContext,
  names: readonly string[],
): Promise<StepFixtures> {
  // `-readonly`: `StepFixtures`'s own members are `readonly` for a step
  // reading them (this file's own header, and context.ts's), but this
  // function is the one place that is allowed to write them, once, while
  // building the bag it then hands back as the (readonly-again) public
  // type.
  const fixtures: { -readonly [K in keyof StepFixtures]?: StepFixtures[K] } = {};
  for (const name of names) {
    switch (name) {
      case "page":
        fixtures.page = await ctx.page();
        break;
      case "context": {
        const page = await ctx.page();
        fixtures.context = page.context();
        break;
      }
      case "request":
        fixtures.request = await ctx.request();
        break;
      case "env":
        fixtures.env = ctx.env;
        break;
      case "requireEnv":
        fixtures.requireEnv = ctx.requireEnv;
        break;
      case "baseURL":
        fixtures.baseURL = ctx.baseURL;
        break;
      case "resultOf":
        fixtures.resultOf = ctx.resultOf;
        break;
      case "section":
        fixtures.section = ctx.section;
        break;
      case "poll":
        fixtures.poll = ctx.poll;
        break;
      case "evidence":
        fixtures.evidence = ctx.evidence;
        break;
      default:
        throw new Error(
          `internal: unknown fixture name "${name}" reached buildStepFixtures, ` +
            "src/step/validate-fixtures.ts should have refused this before execution began",
        );
    }
  }
  return fixtures as StepFixtures;
}
