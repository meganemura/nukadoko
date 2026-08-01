import { existsSync } from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type Page } from "playwright";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
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

export interface EvidenceResult {
  trace?: string;
  screenshots: string[];
  http?: string;
}

export interface StepContextHandle {
  ctx: StepContext;
  /** Closes whatever this execution opened (browser, request context) and
   * reports which evidence files it actually produced, so the receipt only
   * ever lists files that exist (docs/spec.md "Receipts"). */
  dispose(status: "ok" | "failed"): Promise<EvidenceResult>;
}

export interface CreateStepContextOptions {
  rootDir: string;
  config: NukadokoConfig;
  /** Absolute path to this receipt's evidence directory; must already exist. */
  evidenceDir: string;
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
  const { rootDir, config, evidenceDir } = options;
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
        const raw = await playwrightRequest.newContext({ baseURL: config.baseURL });
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

  async function dispose(status: "ok" | "failed"): Promise<EvidenceResult> {
    const evidence: EvidenceResult = { screenshots: [] };

    if (browserHandle) {
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

    return evidence;
  }

  return { ctx, dispose };
}
