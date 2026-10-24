import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { APIRequestContext, BrowserContextOptions, Page } from "playwright";
import type { z } from "zod";
import { formatValidationIssues } from "../issues/format-issues.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { FixtureBag, PollOptions, StepContext } from "../step/context.js";
import type {
  CallEntry,
  NamedTraceEntry,
  ErrorKind,
  HttpOmittedCounts,
  ObservedCounts,
  PageEventsSnapshot,
  PollRecord,
  ScreenshotEntry,
  SectionEntry,
  UsedEntryWithResult,
} from "../record/types.js";
import type { SecretSet } from "../secrets/types.js";
import { fixtureParameterNames } from "../step/fixture-names.js";
import { fixtureSourceOf, type RunStep, type Step } from "../step/define-step.js";
import { parseStepReturns } from "../step/parse-returns.js";
import { strictArgsSchema } from "../step/strict-args.js";
import { launchBrowser, type BrowserHandle, type TracedContextHandle } from "./browser-evidence.js";
import {
  assertValidContextName,
  ContextOptionsConflictError,
  contextFileName,
  snapshotContextOptions,
} from "./context-name.js";
import { createCallsCollector } from "./calls.js";
import { installChannelPatches, withoutChannelRecording } from "./channels.js";

// The commands install the patches before they load the config and the
// step files, earlier than any context exists, and write the line of every
// request still open at their end, after the last context is gone; this
// module is the context layer's surface for both. The runner starts its own
// worker thread to test a claim's regular expression, which is nukadoko's
// work and not the step's, so it reaches the suppression here too.
export { finalizeOpenRequests, installChannelPatches, withoutChannelRecording };
import { loadPlaywright } from "./load-playwright.js";
import { cloneForCaller } from "./clone-stored.js";
import { createEnvReadsCollector } from "./env-reads.js";
import { MissingEnvError, PartNotDeclaredError, ReadOnlyMutatingPartError, ResultsWithheldError, UnregisteredStepError } from "./errors.js";
import { createEvidenceCollector, type EvidenceSnapshot } from "./evidence.js";
import { createScratchCollector } from "./scratch.js";
import { wrapRequestContextWithLogging } from "./http-log.js";
import { createHttpLogFailedCollector } from "./http-log-failed.js";
import { createHttpOmittedCollector } from "./http-omitted.js";
import { type AfterStepEnd, createObservedCollector, finalizeOpenRequests } from "./observed.js";
import { createPageEventsCollector } from "./page-events.js";
import { createProgramLogReader } from "./program-log-slice.js";
import { newTracePrefix, originOf } from "./trace-context.js";
import { pollWithRecording } from "./poll.js";
import { createPollsCollector } from "./polls.js";
import { createSectionsCollector } from "./sections.js";
import { withProcessRecording } from "./run-command.js";
import { createUsedCollector } from "./used.js";

// Responsibility: assemble the real StepContext a `do`/`run` execution builds
// a typed step's fixture bag from (`buildStepFixtures`, below) — env,
// baseURL (also wired into the browser
// context so `page.goto("/path")` resolves against it), lazy browser, lazy
// logged HTTP context — plus a `dispose` the executor calls *after* `run`
// returns, never itself reachable from `ctx`. `ctx.section` and `ctx.poll`
// are both assembled here for the same reason: each only writes into a
// collector below (`sections`, `polls` — same shape as `observed`/`used`),
// so the read side (`sectionsSnapshot()`/`pollsSnapshot()`) and the reset
// (`beginStep`) stay executor-only, the same trust-model rule as everything
// else on this handle — a step can write a label or run a poll but can
// never read back or clear what it or an earlier step already wrote.
// With a world URL, each step boundary is one trace (trace-context.ts):
// `observed` makes its trace id, and every request to the world's origin
// carries it, whichever client sent it. `observedSnapshot` then adds the
// lines of the program's log that carry it (program-log-slice.ts).
// `poll`'s own retry loop still lives entirely in src/context/poll.ts
// (`pollWithRecording`, unchanged in its own right) — this module only owns
// the `polls` collector and binds the two together to produce `ctx.poll`.
// docs/spec.md's Context API boundary rule (`ctx` carries only what the
// executor must inject) is the whole point: docs/spec.md's trust model
// requires that a step cannot control its own step record or evidence
// collection, so nothing evidence-related is exposed on the object passed
// into `run`; only the executor (src/cli/do.ts), which never hands
// `dispose` onward, can call it.
//
// `nuka run` shares one `ctx` across every step of a pickle (docs/spec.md
// "Running": "Steps in one pickle share one context"), but each step's
// http.jsonl still belongs to that step's own step record dir, while a browser's
// trace/screenshots belong to the scenario as a whole. `beginStep` on the
// handle (never on `ctx` itself — sink
// switching stays executor-only, same rule as `dispose`) is the minimal seam
// that split needs: `evidenceDir` only anchors final.png for this ctx's
// whole lifetime, while `boundaryDir` (the trace chunk, attachments and
// http.jsonl) is a separate, mutable pointer the executor advances at each
// step boundary. `nuka do` never calls `beginStep`, so its behavior — one fixed
// dir for both, one observed tally spanning the whole execution — is
// unchanged.
//
// `beginStep` also resets the `observed` collector: the http.jsonl sink and
// the observed collector share one step-boundary concept, so one call
// advances both rather than risking a caller that redirects the log dir but
// forgets to reset the collector (or vice versa). The collector is created
// once, here, and never exposed on `ctx` (same trust-model rule as
// `dispose`/`beginStep`: a step cannot see or reset its own observation).
//
// `beginStep` resets `sections` the same way: `nuka run` shares one `ctx`, hence one `sections` collector,
// across every step of a pickle, so without this reset a later step's
// step record would start out already carrying whichever labels an earlier
// step called `ctx.section` with — the same bleed-across-steps bug this
// reset already prevents for `observed`/`used`.
//
// `beginStep` resets `polls` the same way: one
// `ctx.poll` collector per `ctx`, shared across every step of a pickle just
// like `sections`, so without this reset a later step's step record would
// start out already carrying whichever polls an earlier step made — the
// same bleed-across-steps bug this reset already prevents for
// `observed`/`used`/`sections`.
//
// `beginStep` resets `pageEvents` the same way again: one collector per `ctx`, created once here and handed to
// browser-evidence.ts's launch the same way `observed` is, so a later
// step's step record does not inherit console/uncaught/failed-request
// evidence an earlier step's page already produced. The context's own `console`/
// `weberror`/`requestfailed` subscriptions (browser-evidence.ts) are set up
// once, at context creation, and outlive every reset — `nuka do` never
// calls `beginStep` at all, so its single collector simply accumulates for
// the execution's whole lifetime, the same as `observed`'s.
//
// `beginStep` resets `httpOmitted` the same way again: one collector per `ctx`, created once here and
// handed to browser-evidence.ts's launch the same way `observed`/
// `pageEvents` already are, so a later step's step record does not inherit an
// earlier step's own dropped-asset counts. `ctx.page()`'s own launch call
// (below) also now hands the browser launcher this ctx's current
// `boundaryDir`/`secrets` — the same two values `ctx.request()` already
// reads at call time — so page-issued document/xhr/fetch traffic lands on
// the very same http.jsonl `ctx.request()` writes to, redacted the same
// single way, rather than a second file or a second redaction pass.
//
// `env` arrives already loaded and merged: the executor is the one place that knows the full envFiles list *and*
// which of them are secret sources, so it loads env and builds the run's
// SecretSet itself, once, and hands both down — this module never reads an
// envFile and never decides what is secret. `secrets` only ever reaches
// http-log.ts's redaction; nothing here exposes it on `ctx`, matching
// docs/spec.md "Environments and secrets": redaction is applied by the executor, never
// controllable from a step's `run`.
//
// `resultOf`: the *lookup* — "does
// this Step object have a most-recent successful result, and under which
// step record id" — is the executor's own knowledge (run-scenario.ts's chain, or
// `nuka do`'s always-`undefined` reader), passed in here as `options.resultOf`
// and never computed by this module. What this module owns is the *wrapper*:
// `ctx.resultOf` calls that lookup and, only when it actually returns a
// value, records the step record id (and the step name that step record
// records) on
// the `used` collector below — the same
// "step cannot see or reset its own observation" trust rule as `observed`,
// applied to provenance instead of network calls. `usedSnapshot()` (the
// handle's read side) and `beginStep`'s reset mirror `observedSnapshot()`/its
// own reset exactly, for the same reason: one step boundary, two tallies.
//
// `isRegisteredStep`: before even
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
// below) exists for the *other* way a step record becomes provenance: a `from`
// injection (run-scenario.ts) reads the exact same per-pickle chain
// `resultOf`'s own reader does, but from outside any step's `run()` — before
// it is even called — so it cannot go through the `ctx.resultOf` wrapper at
// all; `recordUsed` lets it write into the very same `used` collector
// instead of needing a second one, which is what keeps a step that is both
// injected into *and* itself calls `ctx.resultOf` for a different upstream
// down to one deduplicated list rather than two.
//
// `requireEnv` records the name it was given on the `envReads` collector
// below *before* throwing `MissingEnvError` — a step whose execution failed
// for a missing key still
// gets a step record showing what it asked for, which matters most exactly
// when a step fails this way. Only `requireEnv` writes to this collector:
// a step that reads `ctx.env[name]` directly never passes through any call
// this module owns, so that read leaves no trace here, on purpose —
// wrapping `ctx.env` itself in a Proxy to catch direct reads too would make
// the fixture heavier for what it would gain, diluting the measurement's
// meaning from "this was required" to merely "this was touched". Same
// lifetime and reset rule as
// `used`/`sections` — one collector per ctx, zeroed by `beginStep`.
//
// `ctx.call` (docs/spec.md "Parts") reads two more things this module didn't
// need before: `stepNameOf`, the same
// "Step object -> the vocabulary name discovery registered it under" lookup
// `resultOf`'s own `used` entries already need a name for, threaded in here
// because a `CallEntry` names its part the same way; and `currentFixtures`,
// a plain mutable pointer (not a collector — nothing about it is a tally)
// the executor sets once per step boundary via `beginStepRun`, right after
// it resolves that step's own fixture bag (`resolveFixtures`, src/fixture/
// resolver.ts, called from outside this module — src/run/run-scenario.ts,
// src/cli/do.ts). `call(part, args)` never rebuilds a bag of its own: docs/
// spec.md "Parts" is explicit that "a part destructures its own names from
// that same bag", so `call` only ever subsets `currentFixtures` down to
// `part.run`'s own destructured names (`subsetPartFixtures` below) —
// `page`/`context`/`request`/`resultOf`/`section`/`poll`/`evidence` a part
// reaches for are the exact same values, and the exact same collectors,
// the calling step already has, which is the whole reason a part's own
// `observed`/`sections`/`used`/`required_env` land on the *caller's* step
// record without this module doing anything special for any one of those
// names. This also makes a part's own custom (`config.fixtures`) needs
// work for free: `resolveFixtures`'s own top-level call already resolves
// the transitive closure of every part's needs (src/step/step-fixture-
// names.ts's `stepFixtureNames`, used by run-scenario.ts/cli/do.ts in place
// of a step's bare `fixtureParameterNames`), so any name a part destructures
// is already a key on `currentFixtures` by the time `call` reads it. A
// part's own `.parts` governs the *next* `call()` it makes, not the calling
// step's — `calls` (src/context/calls.ts) keeps one frame per call chain for
// exactly this reason: `within` brackets a part's own `run()`, so a call
// that part makes from inside its own body is checked, and recorded,
// against that part, not the frame above it. `beginStep` resets both
// `calls` and `currentFixtures` the same way it resets every other
// collector — defense-in-depth, since `beginStepRun` (called later, once
// this boundary's own fixture bag exists) always sets them again before
// `ctx.call` could be reached this step; `nuka do` never calls `beginStep`
// at all, but calls `beginStepRun` exactly once regardless, so both are set
// correctly there too.
//
// `refuseMutatingPart` closes a gap `call` would otherwise open on its own:
// a read-only environment already refuses a declared-mutating *step*
// before it ever runs (run-scenario.ts's own read-only branch, cli/do.ts's
// setup phase), but that check only ever looks at the entry step's own
// `mutates` — a step declared `mutates: false` calling a part declared
// `mutates: true` was never checked at all, and would reach the wire on
// nothing but its caller's unrelated declaration. `call` checks `part`'s
// own `mutates` against this option, the same declaration-trusted way
// every other read-only enforcement in this package already works (docs/
// spec.md "Keyword semantics": the declaration is what's trusted, never
// what execution measures) — this module still never learns what
// `"policy"`/`"environment"` mean; the caller decides and hands back
// either the refusal message or `undefined`.
//
// `beginStep` now also carries a chunk title, and `endStep` is new: the Playwright trace used to be one recording
// for this whole ctx's lifetime; it is now one chunk per *trace-recorded
// boundary*, opened lazily on that boundary's own first `ctx.page()` call
// and closed right after that boundary's own execution finishes — before
// its step record/hook record is built, so `evidence.trace`/`ScenarioHookRecord.
// trace` can say whether that boundary's own chunk actually exists.
// `pendingChunkTitle`/`pendingChunkFileName`/`chunkOpen` below are the
// bookkeeping that makes that lazy-open-eager-close shape work without a
// step or hook ever seeing it: `endStep` is called once per boundary
// (run-scenario.ts, right after that boundary's own step/hook call returns
// or throws, before its own record is written), and `dispose` calls the
// same `closeCurrentChunk` helper as a catch-all, which is the *only*
// closing point `nuka do` ever reaches (it never calls `beginStep`/
// `endStep` at all — one execution is one chunk, titled from
// `CreateStepContextOptions.stepTitle` rather than from any
// `beginStep` call).
//
// A `beginStep` call with no `title` disables chunk-opening entirely until
// the next titled call — the general escape hatch a caller with nothing
// worth tracing can use. run-scenario.ts's own
// Before/After/AfterStep boundaries used to always take that path: hooks
// were deliberately left out of per-step tracing at first, so `ctx.page()`
// during a
// hook still worked, it just produced no trace chunk of its own. That gap
// is closed now — a hook boundary gets a real `title` (and
// its own `chunkFileName`, below) for every individual Before/After/
// AfterStep *invocation*, not once per phase, so each hook call that
// actually touches the browser gets a trace/`actions` of its own, isolated
// from its sibling hooks and from every step's own chunk. A hook boundary
// that never calls `ctx.page()` still opens nothing, the same lazy rule a
// step already follows (below) — `title`/`chunkFileName` being set is not
// itself enough to open a chunk, only a first `ctx.page()` call is.
//
// `pendingChunkFileName` is the second half of
// that same per-boundary state, alongside `pendingChunkTitle` — needed
// because a step's own chunk always writes to `"trace.zip"` inside that
// step's own step record dir (a directory no other chunk ever shares), while
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
// absent, the same rule for a hook invocation as for a step.
//
// `buildStepFixtures` (below) is this module's
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

// `pageAs(name)` gives a step a browser context of its own in the same
// browser (docs/spec.md "Context API"). Each context, the default one
// included, is one `OpenedContext` in `contexts`, keyed by its name
// (`undefined` for the default). Everything that used to be one browser's
// state is now per entry: its trace chunk is open or not, and it writes its
// own chunk file and final screenshot (context-name.ts's
// `contextFileName`). The collectors stay one per `ctx`: every context
// records into the same `pageEvents` and http.jsonl, tagged with `as`, so a
// step record covers every person the step acted as. The browser is launched on the first context's demand and closed in
// `dispose`, after every context's own `finalize`.

export interface EvidenceResult {
  trace?: string;
  named_traces?: NamedTraceEntry[];
  screenshots: ScreenshotEntry[];
  http?: string;
}

export interface DisposeResult {
  evidence: EvidenceResult;
  /** The engine and version this execution actually launched, lifted
   * straight from `browserHandle.browserInfo`
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
   * "Records": only files that exist). Takes no
   * `status`: its only past use was
   * passing it on to `browserHandle.finalize`, which no longer takes one
   * either — see browser-evidence.ts's own header for why keeping an unused
   * `status` parameter here would itself be a misleading residue, implying
   * evidence still varies by outcome when it no longer does. */
  dispose(): Promise<DisposeResult>;
  /** Executor-only: what the current step boundary reached outside its own
   * code (this execution's whole lifetime for `nuka do`, since the last
   * `beginStep` for `nuka run`): processes, requests, files, and what
   * could not be measured. Waits up to a second for requests still open
   * first, and closes the boundary: a request or a `runCommand` process
   * this step's code starts afterwards is written beside its record with
   * `after_step_end` and counted by `afterStepEnd()`. Never exposed on
   * `ctx`. */
  observedSnapshot(): Promise<ObservedCounts>;
  /** Executor-only: how many requests and `runCommand` processes the
   * current boundary's code started after `observedSnapshot()` closed it.
   * Live: read it when the scenario record is built. Never exposed on
   * `ctx`. */
  afterStepEnd(): AfterStepEnd;
  /** Executor-only: every step record this execution actually read a value
   * from since the current step boundary began — through `ctx.resultOf` or a
   * `from` injection alike — deduplicated by step record id, in read order.
   * Never exposed on `ctx` — same rule as `observedSnapshot()`. */
  usedSnapshot(): UsedEntryWithResult[];
  /** Executor-only: records one provenance read the same `used` collector
   * `ctx.resultOf`'s own wrapper writes into, for a read that happens
   * *outside* `ctx.resultOf` entirely — a `from` injection, which fills an
   * args key before the step's `run()`
   * is ever called, so there is no `ctx.resultOf` call for it to ride along
   * with. Never exposed on `ctx`; only the executor (run-scenario.ts) calls
   * this, immediately after actually reading the value it names. `result`
   * is the upstream's own full validated result
   * — carried the same way `ctx.resultOf`'s own wrapper below already does. */
  recordUsed(recordId: string, stepName: string, result: unknown): void;
  /** Executor-only: the `ctx.section` calls made since the current step
   * boundary began, in call order, each entry carrying `at`. Never exposed on
   * `ctx` — same rule as `observedSnapshot()`/`usedSnapshot()`. */
  sectionsSnapshot(): SectionEntry[];
  /** Executor-only: every `ctx.call(part, args)` invocation made *directly*
   * by the current step boundary's own execution, in call order, with a
   * part-of-a-part call already nested under its own entry's `calls` (docs/
   * spec.md "Parts"). Never exposed on `ctx` — same rule as
   * `observedSnapshot()`/`usedSnapshot()`/`sectionsSnapshot()`. */
  callsSnapshot(): CallEntry[];
  /** Executor-only: opens the current step boundary's own root call frame
   * (`step`, whose `parts` the first `ctx.call()` this boundary makes is
   * checked against) and sets the exact fixture bag `ctx.call` subsets from
   * for every part it runs, direct or nested (docs/spec.md "Parts": "a part
   * destructures its own names from that same bag"). Call once, right
   * after resolving this boundary's own fixture bag (`resolveFixtures`, src/
   * fixture/resolver.ts) and before calling `step.run(fixtures, args)` —
   * `nuka run` (run-scenario.ts) and `nuka do` (cli/do.ts) both do. Never
   * exposed on `ctx`. */
  beginStepRun(step: Step, fixtures: FixtureBag): void;
  /** Executor-only: until the next `beginStep`, `ctx.resultOf` throws
   * a `ResultsWithheldError` naming `stepName`, a claim step
   * (docs/spec.md "Claims"). Its `observe` reads the world, and a value
   * from an earlier step reaches it only through `from`, where the record
   * names its origin; an earlier result read in code would let `observe`
   * pick what to read by the value the claim compares. Set before the
   * step's fixtures resolve, so a fixture of the project's that reads
   * `resultOf` while it sets up for this step throws too. Never exposed on
   * `ctx`. */
  withholdResults(stepName: string): void;
  /** Executor-only: runs a step's own body (`step.run`, or a compat
   * step's glue function) so that every `runCommand` it reaches, and every
   * request, file write, and unmeasured action the channel patches see
   * (src/context/channels.ts), records into this boundary's `observed`.
   * The first call in a boundary also reads the scratch directories, the
   * "before" side of `observed.files`. Never exposed on `ctx`: a step
   * cannot open a scope of its own. */
  recordingProcesses<T>(fn: () => T): T;
  /** Executor-only: every `ctx.poll` call that finished since the current
   * step boundary began, in completion order.
   * Never exposed on `ctx` — same rule as `observedSnapshot()`/
   * `sectionsSnapshot()`. */
  pollsSnapshot(): PollRecord[];
  /** Executor-only: the names of the `pageAs(name)` contexts opened so far,
   * in the order they opened. The executor reads each one's chunk file
   * beside the default `trace.zip` after `endStep()`. */
  namedContexts(): string[];
  /** Executor-only: the names `ctx.requireEnv` was called with since the
   * current step boundary began, deduplicated, in read order — recorded
   * even for a call that went on to throw `MissingEnvError`. Never exposed on `ctx` — same rule as
   * `observedSnapshot()`/`usedSnapshot()`/`sectionsSnapshot()`. */
  envReadsSnapshot(): string[];
  /** Executor-only: console errors, uncaught page errors, and failed
   * requests the browser context saw since the current step boundary began,
   * or `undefined` when none of the three
   * happened at all — whether because `ctx.page()` was never called this
   * step, or because it was and the page simply stayed clean. Never exposed
   * on `ctx` — same rule as `observedSnapshot()`/`sectionsSnapshot()`/
   * `pollsSnapshot()`. */
  pageEventsSnapshot(): PageEventsSnapshot | undefined;
  /** Executor-only: how many page-issued requests since the current step
   * boundary began were left out of http.jsonl, by resourceType, or
   * `undefined` when nothing was ever
   * left out this step — whether because `ctx.page()` was never called, or
   * because every request it made was a document/xhr/fetch and none were
   * dropped. Never exposed on `ctx` — same rule as
   * `observedSnapshot()`/`pageEventsSnapshot()`. */
  httpOmittedSnapshot(): HttpOmittedCounts | undefined;
  /** Executor-only: how many http.jsonl lines since the current step
   * boundary began could not be appended, or `undefined` when none failed.
   * Never exposed on `ctx`. */
  httpLogFailedSnapshot(): number | undefined;
  /** Executor-only: every `ctx.evidence.attach`/`.path`
   * result confirmed to exist since the current step boundary began — see
   * src/context/evidence.ts's own `EvidenceCollector.snapshot` doc comment.
   * `async`, unlike every other snapshot on this handle, because confirming
   * a `path()`-allocated file's existence needs a filesystem read. Never
   * exposed on `ctx` — same rule as `observedSnapshot()`/`sectionsSnapshot()`. */
  evidenceSnapshot(): Promise<EvidenceSnapshot>;
  /** Executor-only: advances to the next step boundary — redirects where the
   * *next* `ctx.request()` call logs to (http.jsonl), without disturbing an
   * already-memoized request context's cookies, and resets the `observed`
   * collector, the `used` log, the `sections` log, the `polls` log, the
   * `required_env` log, the `pageEvents` log, and the `httpOmitted` tally to
   * empty. `nuka run`'s executor calls this once per step, right before
   * running it, so a pickle's shared ctx still logs and tallies each step's
   * own network calls, provenance reads, section labels, finished polls,
   * required env names, and page-origin evidence under that step's own
   * step record dir. Also closes whatever trace chunk the *previous* boundary
   * had open (this file's own header) and, when `title`
   * is given, remembers it (and `chunkFileName`) as the new boundary's own
   * chunk title/output file for the next `ctx.page()` call to open lazily.
   * `title` is `undefined` for a boundary with nothing worth tracing, which
   * disables chunk-opening for that boundary entirely — see this file's own
   * header. run-scenario.ts's own Before/After/
   * AfterStep boundaries pass a real `title` (and `chunkFileName`) for every
   * individual hook invocation, the same as a step already does; only a
   * caller that genuinely wants no chunk at all leaves `title` unset now.
   * `chunkFileName` defaults to `"trace.zip"` when omitted (this file's own
   * header) — a step call site never needs to pass one; a hook call site
   * always does, since several hook invocations can share one scenario
   * evidence dir. Never exposed on `ctx` — same executor-only rule as
   * `dispose`. */
  beginStep(dir: string, title?: string, chunkFileName?: string): Promise<void>;
  /** Executor-only (covering hook boundaries too): closes the current
   * boundary's own trace chunk,
   * if one is open, writing it to the current boundary's own directory (the
   * `dir` its own `beginStep` call was given, joined with `chunkFileName`)
   * *before* that step's step record (or that hook invocation's own record)
   * is
   * built — the reason this exists as its own call rather than folding into
   * the *next* `beginStep` (this file's own header: a step record/scenario
   * record is
   * built and written well before the next boundary's `beginStep` ever
   * runs, so waiting for that call would mean `trace` could never
   * truthfully be set on the step record/scenario record that chunk
   * actually belongs
   * to). A no-op when no chunk is open (no browser was ever launched this
   * boundary, or this ctx has no browser handle at all). Never exposed on
   * `ctx`. */
  endStep(): Promise<void>;
}

export interface CreateStepContextOptions {
  config: NukadokoConfig;
  /** The world's base URL (src/program/world-view.ts): `page`, `context`,
   * `request`, and `pageAs` resolve a relative URL against it, and
   * `ctx.baseURL` is it. `undefined` when the run has no world, or a world
   * with neither `serve` nor `url`. */
  baseURL?: string | undefined;
  /** The world's `program.log` (src/program/world-view.ts), which each
   * step's record slices by trace context: its path when nukadoko serves
   * the program, `null` for a world at a `url`, whose log nukadoko does
   * not read. Absent, or ignored without `baseURL`, when there is no
   * world URL. */
  programLog?: string | null | undefined;
  /** The prefix every trace id of the world starts with
   * (src/program/world-view.ts). Without one, the handle makes its own. */
  tracePrefix?: string | undefined;
  /** The world's directory (src/program/world-view.ts). It is inside the
   * state directory, which the file measurement leaves out, and a step's
   * own write there is recorded all the same (observed.ts). */
  worldDir?: string | undefined;
  /** Absolute path to this execution's browser evidence directory (trace.zip,
   * screenshots) and, until `beginStep` first moves it, http.jsonl too; must
   * already exist. */
  evidenceDir: string;
  /** More names a step may not attach or allocate in its record directory,
   * because the caller keeps a file or directory of its own there (src/
   * context/evidence.ts): `nuka do` keeps its world's directory, `world`,
   * beside the record. */
  reservedEvidenceNames?: readonly string[];
  /** The project root. `scratch.copy(source)` resolves a relative `source`
   * against it, so a step names a path in the project the same way whether
   * `nuka` was started there or with another working directory. Defaults
   * to the current working directory. */
  rootDir?: string;
  /** Where the run's records go when that is not `rootDir`'s state
   * directory: a pass in a tree of `nuka run --base` records into head's.
   * Left out of what a step is measured writing, as the state directory
   * is. */
  recordsDir?: string;
  /** The merged env map the executor loaded from every configured envFile.
   * This module never reads an envFile itself, so a run's env files are
   * parsed exactly once no matter how many contexts get created from them.
   * `ctx.env` is a frozen copy of this object, not this object: a write on
   * the copy cannot reach another step, another scenario, or this map. */
  env: Readonly<Record<string, string>>;
  /** Values this run's HTTP log (http.jsonl) must redact; defaults to empty
   * when there is nothing secret to log. Never exposed on `ctx` — only
   * `wrapRequestContextWithLogging` (http-log.ts) sees it. */
  secrets?: SecretSet;
  /** Looks up `step`'s most recent successful result by object identity —
   * the executor's own connection
   * to `ctx.resultOf`. Defaults to a reader that always returns `undefined`,
   * matching `nuka do`'s contract (docs/spec.md "Context API": "undefined
   * under `nuka do`") without every caller that doesn't care about chaining
   * having to say so. `nuka run`'s executor (run-scenario.ts) passes one
   * backed by the current pickle's own chain instead. `stepName` is the
   * step name that step record itself records —
   * carried alongside `recordId` so `used` can cite it without a second
   * lookup, per docs/spec.md "Records": each `used` entry is
   * `{ "step_record_id": ..., "step": ... }`. */
  resultOf?: (step: Step) => { result: unknown; recordId: string; stepName: string } | undefined;
  /** Whether `step` is one discovery actually registered — checked by
   * `ctx.resultOf` before even attempting the
   * `resultOf` lookup above; a `Step` this rejects throws
   * `UnregisteredStepError` instead of the lookup running at all. Defaults to
   * "everything is registered" (`() => true`), matching this option's own
   * `resultOf` default of "nothing is ever readable": a caller that doesn't
   * wire this in gets today's old, permissive behavior rather than a
   * surprise new throw. `nuka run`'s executor (run-scenario.ts) and `nuka
   * do`'s (cli/do.ts) both build this from the same vocabulary they already
   * discovered. */
  isRegisteredStep?: (step: Step) => boolean;
  /** `step`'s own vocabulary name — read by `ctx.call` to name a `CallEntry`
   * and to name both sides of a `PartNotDeclaredError`/`UnregisteredStepError`
   * message (docs/spec.md "Parts"). `undefined` when `step` was never
   * registered at all (`ctx.call` falls back to a generic phrase for that
   * case, the same way run-scenario.ts's own `injectFrom` already does for
   * an unresolved `from` candidate). Defaults to a function that always
   * returns `undefined`, matching this option's own `isRegisteredStep`
   * default of "everything is registered" but with nothing to name — a
   * caller that never calls `ctx.call` doesn't have to wire this in. `nuka
   * run`'s executor (run-scenario.ts) and `nuka do`'s (cli/do.ts) both build
   * this from the same vocabulary map `isRegisteredStep` above already
   * reads. */
  stepNameOf?: (step: Step) => string | undefined;
  /** Whether `ctx.call` must refuse `part` before it ever runs, for the
   * current environment's own `policy` (docs/spec.md "Parts"/"Keyword
   * semantics") — returns the refusal message when it must, `undefined`
   * when `part` may run. This module never learns what `"policy"` or
   * `"environment"` even mean: the caller (run-scenario.ts, cli/do.ts)
   * already has the resolved environment's own name and policy at the
   * point it builds this closure, the same "give the answer, not the
   * ingredients" shape `resultOf`/`isRegisteredStep`/`stepNameOf` above
   * already follow. Checked against `part.mutates` alone — never the
   * calling step's own declaration, which a read-only policy already
   * checked (and refused, if `true`) before this step's own `run` ever
   * started; a step that got this far already declared `mutates: false`
   * or the policy is not `"read-only"` at all, so only a part's own
   * declaration is left to decide. Defaults to "never refuse"
   * (`() => undefined`), matching every other read-only-related default in
   * this package: a caller that doesn't care about this policy (most of
   * this file's own tests, and every `nuka do`/`nuka run` invocation
   * outside a read-only environment) doesn't have to say so. */
  refuseMutatingPart?: (part: Step) => string | undefined;
  /** This ctx's own trace chunk title, for a caller that never calls
   * `beginStep` at all — `nuka do`'s own
   * "one execution is one chunk" shape, titled by the step's name, which is
   * known once, here, and
   * never needs to change again. `undefined` when omitted: no chunk opens
   * until some `title` is set, whether from here or from a later
   * `beginStep(dir, title)` call. `nuka run`'s executor (run-scenario.ts)
   * leaves this unset — its very first `beginStep` call (before any Before
   * hook) always runs before any step or hook code does, so whatever this
   * option would have held is overwritten before it could matter. */
  stepTitle?: string;
}

/** One browser context this ctx opened: the default one (`as` undefined)
 * or a `pageAs(name)` one. */
interface OpenedContext {
  readonly as: string | undefined;
  readonly handle: TracedContextHandle;
  chunkOpen: boolean;
}

export function createStepContext(options: CreateStepContextOptions): StepContextHandle {
  const {
    config,
    baseURL,
    evidenceDir,
    env: sourceEnv,
    secrets = [],
    resultOf: readResultOf = () => undefined,
    isRegisteredStep = () => true,
    stepNameOf = () => undefined,
    refuseMutatingPart = () => undefined,
  } = options;
  // `Readonly` on `sourceEnv` is only a type. The executor passes one object
  // into every scenario, so an assignment on `ctx.env` would otherwise still
  // be there for a later step in this scenario and for a later scenario, and
  // would change the map the executor still holds. The copy is what `ctx`
  // exposes. Freezing it makes the assignment throw in a step module
  // (strict) instead of sticking. It is not a Proxy: a direct read has to
  // stay invisible to `requireEnv`'s log.
  const env = Object.freeze({ ...sourceEnv });
  // Once per process, and before any step file has run: a module that
  // copies `fetch` or `http.request` into a variable before the patches
  // exist keeps the original, and its requests are not seen. The run and
  // do commands install earlier still, before they load step files.
  installChannelPatches();
  // Mutable, unlike browser evidence's fixed `evidenceDir`: `beginStep`
  // (below) is the only way this ever changes, and `do` never calls it, so
  // `do`'s http.jsonl stays exactly where it always has.
  let boundaryDir = evidenceDir;
  // This boundary's own trace chunk title —
  // `undefined` means no chunk should open for this boundary at all (before
  // any `stepTitle`/`beginStep` has ever set one, or a boundary that
  // deliberately wants no chunk). `ctx.page()` reads this lazily, on its own
  // first call within a boundary; `beginStep` is the only thing that ever
  // changes it.
  let pendingChunkTitle: string | undefined = options.stepTitle;
  // This boundary's own chunk output file name, relative to `boundaryDir` —
  // always `"trace.zip"` until a hook boundary
  // (run-scenario.ts) names its own, since several hook invocations can
  // share one scenario evidence dir where a step's own chunk never shares
  // its step record dir with anything else (this file's own header). Only
  // meaningful when `pendingChunkTitle !== undefined`; `beginStep` is the
  // only thing that ever changes it.
  let pendingChunkFileName = "trace.zip";
  // One collector for this ctx's whole lifetime; `beginStep` resets what it
  // holds, never replaces the object itself. The state directory is where this run writes step records and traces
  // while a step runs, so a `runCommand` snapshot would otherwise read the
  // executor's own writes as the program's.
  // Created before `observed`, which counts a request line it could not
  // append into it.
  const httpLogFailed = createHttpLogFailedCollector();
  const worldOrigin = originOf(baseURL);
  const trace = worldOrigin === undefined ? undefined : { prefix: options.tracePrefix ?? newTracePrefix(), origin: worldOrigin };
  const observed = createObservedCollector({
    unwatchedDirs: [
      ...(config.stateDir === undefined ? [] : [path.resolve(options.rootDir ?? process.cwd(), config.stateDir)]),
      ...(options.recordsDir === undefined ? [] : [path.resolve(options.recordsDir)]),
    ],
    ...(options.worldDir === undefined ? {} : { watchedDirs: [options.worldDir] }),
    outputDir: () => boundaryDir,
    secrets,
    httpLogFailed,
    ...(trace === undefined ? {} : { trace }),
  });
  // Created now, so it reads the log from its size at this moment: no line
  // before it can carry a trace id this handle makes.
  const programLog =
    trace !== undefined && typeof options.programLog === "string" ? createProgramLogReader(options.programLog, trace.prefix, secrets) : undefined;
  // Same lifetime rule as `observed`, for provenance instead of network
  // calls.
  const used = createUsedCollector();
  // Same lifetime rule again, for `ctx.section`'s call log.
  const sections = createSectionsCollector();
  // Same lifetime rule again, for `ctx.call`'s own call tree — see this
  // file's own header for why this one is a frame stack, not a flat log.
  const calls = createCallsCollector();
  // The current step boundary's own full fixture bag, set once by
  // `beginStepRun` (below), right after the executor resolves it —
  // `undefined` before the first `beginStepRun` call, and reset to
  // `undefined` by `beginStep` the same defense-in-depth way `calls` itself
  // is (this file's own header). `ctx.call` subsets this rather than
  // building a bag of its own.
  let currentFixtures: FixtureBag | undefined;
  // The claim step `ctx.resultOf` refuses to serve, set by
  // `withholdResults` and cleared by `beginStep`.
  let resultsWithheldFor: string | undefined;
  // Same lifetime rule again, for `ctx.poll`'s own finished-call log.
  const polls = createPollsCollector();
  // Same lifetime rule again, for `ctx.requireEnv`'s name log.
  const envReads = createEnvReadsCollector();
  // Same lifetime rule again, for console errors/uncaught page errors/
  // failed requests the browser context saw —
  // created once, handed to browser-evidence.ts's launch below, and only
  // ever populated if `ctx.page()` is actually called this ctx's lifetime.
  const pageEvents = createPageEventsCollector();
  // Same lifetime rule again, for page-issued requests left out of
  // http.jsonl — created once,
  // handed to browser-evidence.ts's launch below, and only ever populated
  // if `ctx.page()` is actually called this ctx's lifetime.
  const httpOmitted = createHttpOmittedCollector();
  // Same lifetime rule again, for `ctx.evidence.attach`/`.path` —
  // `() => boundaryDir` is the exact same moving-pointer getter
  // `ctx.request()`'s own http.jsonl logging already reads (this file's own
  // header): `beginStep` below redirects both at once, so an attachment
  // always lands beside that step's own http.jsonl, trace.zip, and
  // final.png, never in a stale directory.
  const evidence = createEvidenceCollector(() => boundaryDir, options.reservedEvidenceNames);
  // Lives as long as this handle: `beginStep` only starts a new list for the
  // step record, and `dispose()` removes every directory. Under `nuka run`
  // one handle spans a scenario, so that is where "removed when the
  // scenario ends" comes from.
  const scratch = createScratchCollector({ rootDir: options.rootDir ?? process.cwd() });

  let browserHandle: BrowserHandle | undefined;
  let browserSetup: Promise<BrowserHandle> | undefined;
  // Every browser context this ctx opened, in open order (this file's own
  // header). `chunkOpen` is whether that context has a chunk open for the
  // *current* boundary: set by `setUpPage`, cleared only by
  // `closeCurrentChunk`.
  const contexts = new Map<string | undefined, OpenedContext>();
  // Context setups in flight, so concurrent first calls for one name share
  // one context (see `ctx.page()`), and how many are in flight, so a failed
  // setup closes the browser only when nothing else is using it.
  const pageSetups = new Map<string | undefined, Promise<Page>>();
  let contextOpensInFlight = 0;
  // The options each `pageAs` name was first asked for, recorded before its
  // setup starts so a concurrent second call is compared too. A snapshot,
  // not the caller's object (see `snapshotContextOptions`).
  const requestedOptions = new Map<string, Record<string, unknown>>();
  let requestContext: APIRequestContext | undefined;
  let requestSetup: Promise<APIRequestContext> | undefined;

  // Closes whatever trace chunk is open for the *current* boundary, writing
  // it to `boundaryDir` (this file's own header) — a no-op when nothing is
  // open, covering both "no browser was ever launched this ctx's lifetime"
  // and "this boundary never called `ctx.page()`" without either caller
  // needing to tell the two apart. Called from three places: `beginStep`
  // (closing the *previous* boundary's own chunk — defense-in-depth only,
  // since normal operation always closes a step's own chunk via `endStep`
  // before the next `beginStep` runs), `endStep` itself, and `dispose` (the
  // only closing point `nuka do` ever reaches, since it never calls either
  // of the other two).
  //
  // Also flushes page-http-log.ts's own pending http.jsonl writes now —
  // whenever a browser exists at all, not only
  // when `chunkOpen`: a boundary with no `pendingChunkTitle` (or one that
  // never called `ctx.page()`) never opens a chunk (this file's own header)
  // but can still have produced page-issued http.jsonl entries this
  // boundary needs finished before anything downstream reads that file.
  // Ordered before the chunk close below, though the order between the two
  // does not itself matter — both are cheap, and neither depends on the
  // other having run.
  async function closeCurrentChunk(): Promise<void> {
    for (const opened of contexts.values()) {
      await opened.handle.flushPageHttpLog();
      if (!opened.chunkOpen) {
        continue;
      }
      opened.chunkOpen = false;
      await opened.handle.endStepChunk(path.join(boundaryDir, contextFileName(pendingChunkFileName, opened.as)));
    }
  }

  // `step`'s own vocabulary name, or the same fallback wording run-
  // scenario.ts's own `injectFrom` already uses for an unresolved `from`
  // candidate — `ctx.call`'s two error paths (`PartNotDeclaredError`,
  // `UnregisteredStepError`) and every `CallEntry.step` all name their
  // subject through this one function.
  function partName(step: Step): string {
    return stepNameOf(step) ?? "a step discovery never registered";
  }

  // `part.run`'s own destructured names, read straight off
  // `currentFixtures` — never a freshly built bag (this file's own header:
  // "a part destructures its own names from that same bag"). Both throws
  // here are defense-in-depth: `beginStepRun` always sets `currentFixtures`
  // before a step's own `run()` (hence before `ctx.call` is reachable at
  // all), and src/step/step-fixture-names.ts's `stepFixtureNames` closure
  // is what run-scenario.ts/cli/do.ts already use to guarantee every name a
  // part destructures is a key on that bag before execution ever begins.
  function subsetPartFixtures(part: Step): FixtureBag {
    if (currentFixtures === undefined) {
      throw new Error(
        "internal: ctx.call() reached with no current fixture bag; " +
          "beginStepRun() should have set one before this step's own run() was ever called",
      );
    }
    const bag = currentFixtures as unknown as Record<string, unknown>;
    const subset: Record<string, unknown> = {};
    for (const name of fixtureParameterNames(fixtureSourceOf(part))) {
      if (!(name in bag)) {
        throw new Error(
          `internal: ctx.call() needed fixture "${name}" for a part, but it was not in the current ` +
            "step's own fixture bag; src/step/step-fixture-names.ts's closure should have included " +
            "it before execution began",
        );
      }
      subset[name] = bag[name];
    }
    return subset as unknown as FixtureBag;
  }

  // Records one failed `CallEntry` — shared by `call`'s three failure paths
  // (bad args, the part's own `run` throwing, a bad result) so the shape
  // stays identical across all three: only `kind`/`message`/`nested`
  // differ.
  function recordCallFailure(
    record: (entry: CallEntry) => void,
    step: string,
    args: unknown,
    kind: ErrorKind,
    message: string,
    startedAt: Date,
    nested: readonly CallEntry[],
  ): void {
    record({
      step,
      args,
      error: { message, kind },
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      ...(nested.length > 0 ? { calls: [...nested] } : {}),
    });
  }

  // `ctx.call` itself (docs/spec.md "Parts") — see this file's own header
  // for the design (`currentFixtures`/`calls`' own frame stack). Three
  // gates run before `part.run` ever starts, in order: declared in
  // `caller.parts`, registered by discovery, and — only once both of those
  // hold — allowed to run under the current environment's policy
  // (`refuseMutatingPart`, checked against `part`'s own declared `mutates`,
  // never the caller's). None of the three records a `CallEntry` at all —
  // the part's own `run` never starts, so there is nothing to attest to
  // (the same "an execution that never began must not be citable" rule a
  // step's own undefined/ambiguous match already follows).
  async function call<S extends RunStep>(part: S, args: z.input<S["args"]>): Promise<z.infer<S["returns"]>> {
    const caller = calls.currentStep();
    if (caller === undefined) {
      throw new Error(
        "ctx.call() has no active step boundary: call is only available inside a step's run(), " +
          "after that boundary has opened",
      );
    }
    if (!caller.parts.includes(part)) {
      throw new PartNotDeclaredError(partName(caller), partName(part));
    }
    if (!isRegisteredStep(part)) {
      throw new UnregisteredStepError("call()");
    }
    const refusal = refuseMutatingPart(part);
    if (refusal !== undefined) {
      throw new ReadOnlyMutatingPartError(refusal);
    }

    const name = partName(part);
    const startedAt = new Date();
    const record = calls.reserve();
    const argsResult = strictArgsSchema(part.args).safeParse(args);
    if (!argsResult.success) {
      const message = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
      recordCallFailure(record, name, args, "args_invalid", message, startedAt, []);
      throw new Error(message);
    }

    // Opened right before the part's own `run()` starts, so a call *it*
    // makes is checked against *its own* `parts`, not the caller's (this
    // file's own header, and src/context/calls.ts's).
    const frame = calls.enter(part);
    let runResult: unknown;
    try {
      const fixtures = subsetPartFixtures(part);
      runResult = await calls.within(frame, () => part.run(fixtures, argsResult.data));
    } catch (error) {
      const nested = calls.entriesOf(frame);
      const message = error instanceof Error ? error.message : String(error);
      recordCallFailure(record, name, args, "step_error", message, startedAt, nested);
      throw error;
    }
    const nested = calls.entriesOf(frame);

    const returnsResult = parseStepReturns(part, runResult);
    if (!returnsResult.success) {
      const message = returnsResult.message;
      recordCallFailure(record, name, args, "result_invalid", message, startedAt, nested);
      throw new Error(message);
    }

    record({
      step: name,
      args,
      result: returnsResult.data,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      ...(nested.length > 0 ? { calls: [...nested] } : {}),
    });
    // The record keeps the validated result. The caller gets a copy.
    return cloneForCaller(returnsResult.data) as z.infer<S["returns"]>;
  }

  const ctx: StepContext = {
    env,
    requireEnv(name: string): string {
      // Recorded first, before the presence check below can throw: a run
      // that fails for a missing key still gets a step record showing what
      // it asked for, and
      // this is the one call site the library controls, so a name recorded
      // here is a real measurement, not a claim. Name only, never the
      // value — a value can be a secret.
      envReads.record(name);
      // Bracket access walks Object.prototype, so "toString" and
      // "constructor" read as functions on an env object that never set
      // them. Those are not configured values. Only an own key is.
      const value = Object.hasOwn(env, name) ? env[name] : undefined;
      // Empty string is "not set", same reasoning as MissingEnvError's own
      // doc comment: an envFile's `KEY=` line parses to `""`, not "omitted",
      // so treating `""` as present here would defeat the whole point of a
      // presence check.
      if (value === undefined || value === "") {
        throw new MissingEnvError(name);
      }
      return value;
    },
    baseURL,
    async page(): Promise<Page> {
      return pageOf(undefined, undefined);
    },
    async pageAs(name: string, options?: BrowserContextOptions): Promise<Page> {
      assertValidContextName(name);
      if (requestedOptions.has(name)) {
        // A later call without options reaches the context as it is. One
        // with options must ask for what the context already has: Playwright
        // fixes a context's options when it creates it.
        if (options !== undefined && !isDeepStrictEqual(snapshotContextOptions(options), requestedOptions.get(name))) {
          throw new ContextOptionsConflictError(name);
        }
      } else {
        requestedOptions.set(name, snapshotContextOptions(options));
      }
      // The snapshot opens the context too, so what Playwright receives is
      // what later calls are compared against, even if the caller mutates
      // its object while the browser is still launching.
      return pageOf(name, requestedOptions.get(name) as BrowserContextOptions);
    },
    async request(): Promise<APIRequestContext> {
      // Same sharing as `ctx.page()`: two concurrent first calls must not each
      // open a context and leak the first.
      // Outside the channel recording, like the browser below: the request
      // context's own setup is nukadoko's, not the step's.
      requestSetup ??= withoutChannelRecording(() => setUpRequest()).finally(() => {
        requestSetup = undefined;
      });
      return requestSetup;
    },
    resultOf<S extends Step>(step: S) {
      // Checked before the lookup even runs: a Step object discovery never
      // registered has nothing legitimate
      // to look up at all, and silently returning `undefined` for it (the
      // old behavior, before this check existed) is indistinguishable from
      // "registered, just
      // hasn't run yet" — exactly the mistake this throw exists to surface
      // instead (see UnregisteredStepError's own doc comment).
      if (!isRegisteredStep(step)) {
        throw new UnregisteredStepError();
      }
      if (resultsWithheldFor !== undefined) {
        throw new ResultsWithheldError(resultsWithheldFor);
      }
      const entry = readResultOf(step);
      if (entry === undefined) {
        return undefined;
      }
      // Recorded only on an actual read (omit when empty — a call that
      // returned `undefined` leaves no
      // trace). `entry.result` is carried alongside the same way a `from`
      // injection's own `recordUsed` call does.
      used.record(entry.recordId, entry.stepName, entry.result);
      // The chain and this `used` entry keep `entry.result`. The caller gets
      // a copy, so a later read still sees the validated value.
      return cloneForCaller(entry.result) as z.infer<S["returns"]>;
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
    call,
    // `attach`/`path` handed straight through from the
    // collector above — this object literal is what both `StepContext.
    // evidence` and (via `buildStepFixtures`, below) `StepFixtures.evidence`
    // actually are; `snapshot`/`reset` are deliberately left off, the same
    // executor-only rule every other collector on this file already follows.
    evidence: { attach: evidence.attach, path: evidence.path },
    scratch: scratch.scratch,
  };

  // Names what asked for Playwright in the error a project without it sees:
  // the current step's or hook's own title when a boundary has one, the bare
  // API otherwise.
  function neededBy(api: string): string {
    return pendingChunkTitle === undefined ? api : `${api} in "${pendingChunkTitle}"`;
  }

  // Shared by concurrent first calls (`Promise.all([ctx.page(), ctx.page()])`):
  // each would otherwise see no context, open its own, and leak the one the
  // other stored first. Cleared once settled so a failed setup is retried by
  // the next call.
  function pageOf(as: string | undefined, options: BrowserContextOptions | undefined): Promise<Page> {
    let setup = pageSetups.get(as);
    if (setup === undefined) {
      // Outside the channel recording: launching the browser spawns it and
      // writes Playwright's own files, and those are nukadoko's actions,
      // not the step's. Everything the browser emits later runs in the
      // context it was launched in, so its later work is left out too.
      setup = withoutChannelRecording(() => setUpPage(as, options)).finally(() => {
        pageSetups.delete(as);
      });
      pageSetups.set(as, setup);
    }
    return setup;
  }

  function ensureBrowser(api: string): Promise<BrowserHandle> {
    if (browserHandle) {
      return Promise.resolve(browserHandle);
    }
    browserSetup ??= launchBrowser({
      neededBy: neededBy(api),
      // `config.browserType`: which of chromium/firefox/webkit to launch;
      // `undefined` behaves like `"chromium"` (browser-evidence.ts's own
      // default).
      browserType: config.browserType,
      browser: config.browser,
      artifactsParent: evidenceDir,
    })
      .then((launched) => {
        browserHandle = launched;
        // Playwright's own files, written while a step drives the page,
        // are not the step's (browser-evidence.ts's own header).
        for (const dir of launched.outputDirs) observed.ignoreDir(dir);
        return launched;
      })
      .finally(() => {
        browserSetup = undefined;
      });
    return browserSetup;
  }

  // What `browser.newContext` receives. `config.browserContext` first:
  // schema.ts already rejects one that sets `baseURL`, so nukadoko's own
  // value after it never collides with it. Its own options come last, so a step can
  // turn off JavaScript (or set anything else Playwright accepts) for that
  // one context.
  function contextOptionsFor(
    as: string | undefined,
    options: BrowserContextOptions | undefined,
  ): BrowserContextOptions {
    return {
      ...(config.browserContext ?? {}),
      ...(baseURL ? { baseURL } : {}),
      ...(options ?? {}),
    };
  }

  async function openContext(
    as: string | undefined,
    options: BrowserContextOptions | undefined,
  ): Promise<OpenedContext> {
    contextOpensInFlight += 1;
    try {
      const browser = await ensureBrowser(as === undefined ? "ctx.page()" : "pageAs()");
      const handle: TracedContextHandle = await browser.openTracedContext({
        ...(as !== undefined ? { as } : {}),
        contextOptions: contextOptionsFor(as, options),
        evidenceDir,
        pageEvents,
        // Same getter/secrets pair `ctx.request()` (below) already reads
        // at call time: page-issued traffic lands on the very same
        // http.jsonl, redacted the very same way (this file's own header).
        logPath: () => path.join(boundaryDir, "http.jsonl"),
        secrets,
        httpOmitted,
        httpLogFailed,
        ...(trace === undefined ? {} : { stamp: { origin: trace.origin, traceparentFor: (url: string) => observed.traceparentFor(url) } }),
      });
      const opened: OpenedContext = { as, handle, chunkOpen: false };
      contexts.set(as, opened);
      return opened;
    } catch (error) {
      if (as !== undefined) {
        requestedOptions.delete(as);
      }
      // A browser no context uses would stay alive for the rest of the run:
      // `dispose` only closes what an opened context reached.
      if (contexts.size === 0 && contextOpensInFlight === 1 && browserHandle) {
        const unused = browserHandle;
        browserHandle = undefined;
        await unused.close();
      }
      throw error;
    } finally {
      contextOpensInFlight -= 1;
    }
  }

  async function setUpPage(as: string | undefined, options: BrowserContextOptions | undefined): Promise<Page> {
    const opened = contexts.get(as) ?? (await openContext(as, options));
    // The first call of this boundary for this context opens its chunk.
    // `pendingChunkTitle` undefined is a boundary with nothing worth tracing
    // (a caller with no `stepTitle` that also never calls `beginStep`),
    // which gets a page with no chunk, on purpose.
    if (!opened.chunkOpen && pendingChunkTitle !== undefined) {
      await opened.handle.beginStepChunk(pendingChunkTitle);
      opened.chunkOpen = true;
    }
    return opened.handle.page;
  }

  async function setUpRequest(): Promise<APIRequestContext> {
    if (!requestContext) {
      // No `baseURL` requirement here, matching `ctx.page()` above, which
      // already passes `baseURL` through as `undefined` without
      // complaint — a suite
      // that only ever talks to absolute URLs across several hosts has no
      // single baseURL to state, and forcing one into config would make
      // config assert something untrue. If a step written against a
      // relative path actually needs a baseURL and none was configured,
      // Playwright's own `newContext`/fetch call fails on that URL; this
      // module does not duplicate Playwright's URL-resolution rules to
      // pre-empt that with its own error.
      //
      // `config.requestContext` is spread in
      // first, `baseURL` after: schema.ts already rejects a
      // `requestContext` that sets it, so this ordering never actually
      // resolves a real collision, only guards the invariant.
      // Loaded here, not at module load: `playwright` is an optional
      // peer (load-playwright.ts), and a step that never calls
      // `ctx.request()` never reaches this line.
      const { request: playwrightRequest } = await loadPlaywright(neededBy("ctx.request()"));
      const raw = await playwrightRequest.newContext({
        ...(config.requestContext ?? {}),
        ...(baseURL ? { baseURL } : {}),
      });
      requestContext = wrapRequestContextWithLogging(
        raw,
        () => path.join(boundaryDir, "http.jsonl"),
        secrets,
        httpLogFailed,
        baseURL,
        config.requestContext?.extraHTTPHeaders,
      );
    }
    return requestContext;
  }

  async function dispose(): Promise<DisposeResult> {
    // In `finally`: a teardown failure above must not leave the scenario's
    // scratch directories behind.
    try {
      return await disposeOpenedResources();
    } finally {
      await scratch.removeAll();
    }
  }

  async function disposeOpenedResources(): Promise<DisposeResult> {
    const evidence: EvidenceResult = { screenshots: [] };
    if (browserHandle) {
      // Closes whatever chunk the *current* boundary still has open (this
      // file's own header) — the only closing point `nuka do` ever reaches
      // (it calls neither `beginStep` nor `endStep`), and, for `nuka run`, a
      // defense-in-depth no-op: every step's and hook's own chunk is already
      // closed by its own `endStep()` call well before `dispose()` ever
      // runs. Must run before finalize() below: `endStepChunk` needs a
      // still-open context.
      await closeCurrentChunk();
      // The default context first, then each `pageAs` context in the order
      // it opened, so `screenshots[0]` stays the default page's when there
      // is one.
      for (const opened of [...contexts.values()].sort((a, b) => Number(a.as !== undefined) - Number(b.as !== undefined))) {
        evidence.screenshots.push(...(await opened.handle.finalize(contextFileName("final.png", opened.as))));
      }
      await browserHandle.close();
      // Only claim the chunk file exists if `closeCurrentChunk` actually got
      // to write it: `endStepChunk` swallows its own failure (the browser/
      // context can be gone by the time it runs), so this must be checked
      // the same way http.jsonl is below rather than assumed (docs/spec.md
      // "Records": evidence lists only files that exist). `boundaryDir`/
      // `pendingChunkFileName`, not `evidenceDir`/`"trace.zip"`: the same
      // directory and file name `closeCurrentChunk` just wrote to, which for
      // `nuka run`'s own scenario-level `dispose()` this field is not
      // actually read from (run-scenario.ts builds `ScenarioRecord.evidence`
      // from `screenshots` alone) — kept accurate anyway, since `nuka do`'s
      // own step record does read it, and `pendingChunkFileName` stays
      // `"trace.zip"` for `nuka do` regardless (it never calls `beginStep`).
      if (existsSync(path.join(boundaryDir, pendingChunkFileName))) {
        evidence.trace = pendingChunkFileName;
      }
      const namedTraces = namedContexts()
        .map((as) => ({ as, file: contextFileName(pendingChunkFileName, as) }))
        .filter((entry) => existsSync(path.join(boundaryDir, entry.file)));
      if (namedTraces.length > 0) {
        evidence.named_traces = namedTraces;
      }
    }

    if (requestContext) {
      try {
        await requestContext.dispose();
      } catch {
        // As with browser teardown above, losing the request context's own
        // dispose() is not a reason to lose the step record; http.jsonl is
        // written incrementally as calls happen, so it is unaffected by a
        // dispose() failure here.
      }
    }

    // Checked unconditionally, not only when `requestContext` was opened:
    // http.jsonl can now exist from
    // `ctx.page()`'s own document/xhr/fetch traffic alone, with
    // `ctx.request()` never called at all — gating this on `requestContext`
    // would leave `evidence.http` `undefined` for exactly that run even
    // though the file it names is sitting right there. Reflects whichever
    // directory is *current* at dispose time. For `do` that is always
    // `evidenceDir` (it never calls `beginStep`); for `nuka run`, dispose()
    // only ever runs once, at the whole scenario's end, so this field is not
    // what a step's own step record relies on — the executor checks each
    // step's
    // own step record dir directly, right after that step finishes, before the
    // log dir advances again.
    if (existsSync(path.join(boundaryDir, "http.jsonl"))) {
      evidence.http = "http.jsonl";
    }

    return {
      evidence,
      // Measured, not declared (DisposeResult's own doc comment) — absent
      // whenever no browser was ever launched this ctx's lifetime, same
      // "no browser, no field" rule `evidence.trace` already follows.
      ...(browserHandle ? { browser: browserHandle.browserInfo } : {}),
    };
  }

  async function observedSnapshot(): Promise<ObservedCounts> {
    await observed.flush();
    const counts = observed.snapshot(scratch.allDirs());
    observed.close();
    const boundaryTrace = observed.boundaryTrace();
    if (boundaryTrace === undefined) return counts;
    if (programLog === undefined) return options.programLog === null ? { ...counts, program_log: null } : counts;
    return { ...counts, program_log: await programLog.slice(boundaryDir, boundaryTrace) };
  }

  function usedSnapshot(): UsedEntryWithResult[] {
    return used.snapshot();
  }

  function recordUsed(recordId: string, stepName: string, result: unknown): void {
    used.record(recordId, stepName, result);
  }

  function sectionsSnapshot(): SectionEntry[] {
    return sections.snapshot();
  }

  function callsSnapshot(): CallEntry[] {
    return calls.snapshot();
  }

  function beginStepRun(step: Step, fixtures: FixtureBag): void {
    calls.beginRoot(step);
    currentFixtures = fixtures;
  }

  function withholdResults(stepName: string): void {
    resultsWithheldFor = stepName;
  }

  function pollsSnapshot(): PollRecord[] {
    return polls.snapshot();
  }

  function namedContexts(): string[] {
    return [...contexts.keys()].filter((as): as is string => as !== undefined);
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

  function httpLogFailedSnapshot(): number | undefined {
    return httpLogFailed.snapshot();
  }

  async function evidenceSnapshot(): Promise<EvidenceSnapshot> {
    return { ...(await evidence.snapshot()), scratch: scratch.snapshot() };
  }

  async function beginStep(dir: string, title?: string, chunkFileName?: string): Promise<void> {
    // Closes the *previous* boundary's own chunk before this boundary's own
    // `boundaryDir`/`pendingChunkTitle`/`pendingChunkFileName` overwrite the
    // state that closing needs (this file's own header) — a no-op in normal
    // operation, since `endStep()` already closed the previous boundary's
    // own chunk before this ever runs; real insurance only for a boundary
    // that somehow left one open.
    await closeCurrentChunk();
    boundaryDir = dir;
    pendingChunkTitle = title;
    pendingChunkFileName = chunkFileName ?? "trace.zip";
    observed.reset();
    used.reset();
    sections.reset();
    calls.reset();
    currentFixtures = undefined;
    resultsWithheldFor = undefined;
    polls.reset();
    envReads.reset();
    pageEvents.reset();
    httpOmitted.reset();
    httpLogFailed.reset();
    evidence.reset();
    scratch.reset();
  }

  async function endStep(): Promise<void> {
    await closeCurrentChunk();
  }

  return {
    ctx,
    dispose,
    observedSnapshot,
    afterStepEnd: () => observed.afterStepEnd(),
    usedSnapshot,
    recordUsed,
    sectionsSnapshot,
    callsSnapshot,
    beginStepRun,
    withholdResults,
    recordingProcesses: <T>(fn: () => T): T => withProcessRecording(observed.openRun(scratch.allDirs()), fn),
    pollsSnapshot,
    namedContexts,
    envReadsSnapshot,
    pageEventsSnapshot,
    httpOmittedSnapshot,
    httpLogFailedSnapshot,
    evidenceSnapshot,
    beginStep,
    endStep,
  };
}

/**
 * Resolves `names` (a typed step's own `fixtureParameterNames(step.run)`,
 * src/step/fixture-names.ts) into a `StepFixtures` bag, reading each named
 * fixture off `ctx` (this file's own `createStepContext` output) — the
 * "build only what was named" half of the fixture bag's design:
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
 * `names` is trusted to already be validated (src/fixture/validate-
 * fixtures.ts, run before execution in `nuka check`/`nuka run`/`nuka do`'s
 * own setup phase) — every name in it is one of `StepFixtures`'s own
 * members. The `default` branch below is defense-in-depth only: it should
 * be unreachable in practice, and throwing plainly (not silently building a
 * bag missing a key) is what has to happen if that assumption is ever wrong.
 */
export async function buildStepFixtures(
  ctx: StepContext,
  names: readonly string[],
): Promise<FixtureBag> {
  // `-readonly`: `StepFixtures`'s own members are `readonly` for a step
  // reading them (this file's own header, and src/step/context.ts's), but this
  // function is the one place that is allowed to write them, once, while
  // building the bag it then hands back as the (readonly-again) public
  // type.
  const fixtures: { -readonly [K in keyof FixtureBag]?: FixtureBag[K] } = {};
  for (const name of names) {
    switch (name) {
      case "page":
        fixtures.page = await ctx.page();
        break;
      case "pageAs":
        // A function, like `poll`: nothing opens until the step calls it.
        fixtures.pageAs = ctx.pageAs;
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
      case "call":
        fixtures.call = ctx.call;
        break;
      case "evidence":
        fixtures.evidence = ctx.evidence;
        break;
      case "scratch":
        fixtures.scratch = ctx.scratch;
        break;
      default:
        throw new Error(
          `internal: unknown fixture name "${name}" reached buildStepFixtures, ` +
            "src/fixture/validate-fixtures.ts should have refused this before execution began",
        );
    }
  }
  return fixtures as FixtureBag;
}
