import { existsSync } from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type Page } from "playwright";
import type { z } from "zod";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import type { PollRecord } from "../receipt/types.js";
import type { SecretSet } from "../secrets/types.js";
import type { Step } from "../step/define-step.js";
import type { StorageState } from "../session/storage-state.js";
import { launchBrowserWithTracing, type BrowserEvidenceHandle } from "./browser-evidence.js";
import { createEnvReadsCollector } from "./env-reads.js";
import { MissingEnvError, UnregisteredStepError } from "./errors.js";
import { wrapRequestContextWithLogging } from "./http-log.js";
import { createObservedCollector, type ObservedCounts } from "./observed.js";
import { pollWithRecording, type PollOptions } from "./poll.js";
import { createPollsCollector } from "./polls.js";
import { createSectionsCollector } from "./sections.js";
import { createUsedCollector, type UsedEntry } from "./used.js";

// Responsibility: assemble the real StepContext a `do`/`run` execution hands
// to a step's `run(ctx, args)` — env, baseURL (also wired into the browser
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

export interface EvidenceResult {
  trace?: string;
  screenshots: string[];
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
}

export interface StepContextHandle {
  ctx: StepContext;
  /** Closes whatever this execution opened (browser, request context),
   * reports which evidence files it actually produced (docs/spec.md
   * "Receipts": only files that exist), and hands back the storageState (if
   * any) the executor should persist for this run's session. */
  dispose(status: "ok" | "failed"): Promise<DisposeResult>;
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
  usedSnapshot(): UsedEntry[];
  /** Executor-only: records one provenance read the same `used` collector
   * `ctx.resultOf`'s own wrapper writes into, for a read that happens
   * *outside* `ctx.resultOf` entirely — a `from` injection (m6a-from-core
   * task spec, items 4-5), which fills an args key before the step's `run()`
   * is ever called, so there is no `ctx.resultOf` call for it to ride along
   * with. Never exposed on `ctx`; only the executor (run-scenario.ts) calls
   * this, immediately after actually reading the value it names. */
  recordUsed(receiptId: string, stepName: string): void;
  /** Executor-only: the labels `ctx.section` was called with since the
   * current step boundary began, in call order (t3-sections task spec,
   * decisions 1-2). Never exposed on `ctx` — same rule as
   * `observedCounts()`/`usedSnapshot()`. */
  sectionsSnapshot(): string[];
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
  /** Executor-only: advances to the next step boundary — redirects where the
   * *next* `ctx.request()` call logs to (http.jsonl), without disturbing an
   * already-memoized request context's cookies, and resets the `observed`
   * tally, the `used` log, the `sections` log, the `polls` log, and the
   * `required_env` log to empty. `nuka run`'s executor calls this once per
   * step, right before running it, so a pickle's shared ctx still logs and
   * tallies each step's own network calls, provenance reads, section
   * labels, finished polls, and required env names under that step's own
   * receipt dir (m1-run task spec, decision 5; m2pre-observed task spec,
   * decision 2; t3-sections task spec, decision 4; ctx-poll-receipt task
   * spec; env-reads-and-mutates-doc task spec, item A). Never exposed on
   * `ctx` — same executor-only rule as `dispose`. */
  beginStep(dir: string): void;
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

  let browserHandle: BrowserEvidenceHandle | undefined;
  let requestContext: APIRequestContext | undefined;

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
          browser: config.browser,
          // `config.browserContext` (context-options task spec) — schema.ts
          // already rejects a `browserContext` that sets `baseURL`/
          // `storageState`, so the two args below can never collide with
          // it; browser-evidence.ts still spreads them in last anyway.
          browserContext: config.browserContext,
          evidenceDir,
          storageState,
          observed,
          baseURL: config.baseURL,
        });
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
      // 2: omit when empty — a call that returned `undefined` leaves no trace).
      used.record(entry.receiptId, entry.stepName);
      return entry.result as z.infer<S["returns"]>;
    },
    section(label: string): void {
      sections.record(label);
    },
    poll<T>(fn: () => Promise<T | undefined>, options: PollOptions = {}): Promise<T> {
      return pollWithRecording(fn, options, (finished) => {
        polls.record({
          ...(options.description !== undefined ? { description: options.description } : {}),
          attempts: finished.attempts,
          waited_ms: finished.waitedMs,
          outcome: finished.outcome,
        });
      });
    },
  };

  async function dispose(status: "ok" | "failed"): Promise<DisposeResult> {
    const evidence: EvidenceResult = { screenshots: [] };
    let browserStorageState: StorageState | undefined;
    let requestStorageState: StorageState | undefined;

    if (browserHandle) {
      // Must run before finalize() below: finalize() closes the context,
      // and storageState() can only succeed on one that's still open (see
      // browser-evidence.ts's collectStorageState doc comment).
      browserStorageState = await browserHandle.collectStorageState();
      evidence.screenshots = await browserHandle.finalize(status);
      // Only claim trace.zip exists if tracing.stop actually got to write
      // it: browser-evidence.ts's finalize swallows tracing.stop failures
      // (the browser/context can be gone by the time it runs), so this must
      // be checked the same way http.jsonl is below rather than assumed
      // (docs/spec.md "Receipts": evidence lists only files that exist).
      if (existsSync(path.join(evidenceDir, "trace.zip"))) {
        evidence.trace = "trace.zip";
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
      // Reflects whichever directory is *current* at dispose time. For `do`
      // that is always `evidenceDir` (it never calls `beginStep`); for
      // `nuka run`, dispose() only ever runs once, at the whole scenario's
      // end, so this field is not what a step's own receipt relies on — the
      // executor checks each step's own receipt dir directly, right after
      // that step finishes, before the log dir advances again.
      if (existsSync(path.join(httpLogDir, "http.jsonl"))) {
        evidence.http = "http.jsonl";
      }
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

    return { evidence, storageState: storageStateToPersist };
  }

  function observedCounts(): ObservedCounts {
    return observed.snapshot();
  }

  function usedSnapshot(): UsedEntry[] {
    return used.snapshot();
  }

  function recordUsed(receiptId: string, stepName: string): void {
    used.record(receiptId, stepName);
  }

  function sectionsSnapshot(): string[] {
    return sections.snapshot();
  }

  function pollsSnapshot(): PollRecord[] {
    return polls.snapshot();
  }

  function envReadsSnapshot(): string[] {
    return envReads.snapshot();
  }

  function beginStep(dir: string): void {
    httpLogDir = dir;
    observed.reset();
    used.reset();
    sections.reset();
    polls.reset();
    envReads.reset();
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
    beginStep,
  };
}
