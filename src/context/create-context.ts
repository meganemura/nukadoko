import { existsSync } from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type Page } from "playwright";
import type { z } from "zod";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import type { SecretSet } from "../secrets/types.js";
import type { Step } from "../step/define-step.js";
import type { StorageState } from "../session/storage-state.js";
import { launchBrowserWithTracing, type BrowserEvidenceHandle } from "./browser-evidence.js";
import { wrapRequestContextWithLogging } from "./http-log.js";
import { createObservedCollector, type ObservedCounts } from "./observed.js";
import { poll } from "./poll.js";
import { createUsedCollector } from "./used.js";

// Responsibility: assemble the real StepContext a `do`/`run` execution hands
// to a step's `run(ctx, args)` — env, baseURL, lazy browser, lazy logged
// HTTP context, poll, and a no-op section — plus a `dispose` the executor
// calls *after* `run` returns, never itself reachable from `ctx`. That split
// is the whole point: docs/spec.md's trust model requires that a step
// cannot control its own receipt or evidence collection, so nothing
// evidence-related is exposed on the object passed into `run`; only the
// executor (src/cli/do.ts), which never hands `dispose` onward, can call it.
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
// value, records the receipt id on the `used` collector below — the same
// "step cannot see or reset its own observation" trust rule as `observed`,
// applied to provenance instead of network calls. `usedReceiptIds()` (the
// handle's read side) and `beginStep`'s reset mirror `observedCounts()`/its
// own reset exactly, for the same reason: one step boundary, two tallies.

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
  /** Executor-only: the receipt ids `ctx.resultOf` actually read a value from
   * since the current step boundary began, deduplicated, in read order
   * (m2pre-resultof task spec, decision 2). Never exposed on `ctx` — same
   * rule as `observedCounts()`. */
  usedReceiptIds(): string[];
  /** Executor-only: advances to the next step boundary — redirects where the
   * *next* `ctx.request()` call logs to (http.jsonl), without disturbing an
   * already-memoized request context's cookies, and resets the `observed`
   * tally to zero. `nuka run`'s executor calls this once per step, right
   * before running it, so a pickle's shared ctx still logs and tallies each
   * step's own network calls under that step's own receipt dir (m1-run task
   * spec, decision 5; m2pre-observed task spec, decision 2). Never exposed
   * on `ctx` — same executor-only rule as `dispose`. */
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
   * backed by the current pickle's own chain instead. */
  resultOf?: (step: Step) => { result: unknown; receiptId: string } | undefined;
}

function isBrowserHeadless(config: NukadokoConfig): boolean {
  // `config.browser` is intentionally loosely typed in config/schema.ts —
  // its concrete shape isn't designed yet (see HANDOFF's open items). Duck-
  // typing the one field this slice needs is preferable to blocking on that
  // design or widening the schema ourselves.
  const browser = config.browser as { headless?: boolean } | undefined;
  return browser?.headless ?? true;
}

export function createStepContext(options: CreateStepContextOptions): StepContextHandle {
  const {
    config,
    evidenceDir,
    env,
    secrets = [],
    storageState,
    resultOf: readResultOf = () => undefined,
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

  let browserHandle: BrowserEvidenceHandle | undefined;
  let requestContext: APIRequestContext | undefined;

  const ctx: StepContext = {
    env,
    baseURL: config.baseURL,
    async page(): Promise<Page> {
      if (!browserHandle) {
        browserHandle = await launchBrowserWithTracing({
          headless: isBrowserHeadless(config),
          evidenceDir,
          storageState,
          observed,
        });
      }
      return browserHandle.page;
    },
    async request(): Promise<APIRequestContext> {
      if (!requestContext) {
        if (!config.baseURL) {
          throw new Error(
            'ctx.request() requires a baseURL: set "baseURL" in nukadoko.config.ts',
          );
        }
        const raw = await playwrightRequest.newContext({
          baseURL: config.baseURL,
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
    poll,
    resultOf<S extends Step>(step: S) {
      const entry = readResultOf(step);
      if (entry === undefined) {
        return undefined;
      }
      // Recorded only on an actual read (m2pre-resultof task spec, decision
      // 2: "空なら省略" — a call that returned `undefined` leaves no trace).
      used.record(entry.receiptId);
      return entry.result as z.infer<S["returns"]>;
    },
    section() {
      // No-op for now: the progress log this would append to is a later
      // slice (docs/spec.md "Context API" lists `section`, but nothing
      // reads a progress log yet). Kept as a real, callable no-op rather
      // than omitted so step code written against the full Context API
      // type-checks and runs today, unchanged once progress logs land.
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

  function usedReceiptIds(): string[] {
    return used.snapshot();
  }

  function beginStep(dir: string): void {
    httpLogDir = dir;
    observed.reset();
    used.reset();
  }

  return { ctx, dispose, observedCounts, usedReceiptIds, beginStep };
}
