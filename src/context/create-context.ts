import { existsSync } from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type Page } from "playwright";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import type { StorageState } from "../session/storage-state.js";
import { launchBrowserWithTracing, type BrowserEvidenceHandle } from "./browser-evidence.js";
import { loadEnvFiles } from "./env.js";
import { wrapRequestContextWithLogging } from "./http-log.js";
import { poll } from "./poll.js";

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
}

export interface CreateStepContextOptions {
  rootDir: string;
  config: NukadokoConfig;
  /** Absolute path to this receipt's evidence directory; must already exist. */
  evidenceDir: string;
  /** A `--session`'s previously saved storageState, when one was loaded and
   * parsed successfully; `undefined` for a session's first-ever use or when
   * `--session` wasn't given. Restored into whichever of `ctx.page()` /
   * `ctx.request()` the step actually opens — never both eagerly, since
   * neither is created until first use. */
  storageState?: StorageState;
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
  const { rootDir, config, evidenceDir, storageState } = options;
  const env = loadEnvFiles(rootDir, config.envFiles ?? []);
  const httpLogPath = path.join(evidenceDir, "http.jsonl");

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
        requestContext = wrapRequestContextWithLogging(raw, httpLogPath);
      }
      return requestContext;
    },
    poll,
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
      if (existsSync(httpLogPath)) {
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

  return { ctx, dispose };
}
