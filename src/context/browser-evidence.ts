import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { StorageState } from "../session/storage-state.js";
import type { ObservedCollector } from "./observed.js";

// Responsibility: the Playwright side of evidence collection when a step
// calls `ctx.page()` — launch chromium, trace the whole browser context,
// and capture screenshot(s) at the end — kept separate from
// context/create-context.ts so that module isn't also responsible for
// Playwright's specific launch/newContext/tracing/newPage lifecycle and its
// mirrored teardown. `finalize` is never reachable from a step's `run`: only
// create-context.ts's `dispose` (executor-only) calls it, after `run` has
// already returned or thrown.
//
// The browser context's own `request` events are also tallied into
// `observed` (this task's spec, scope item 2): every request the page
// itself issues — navigation, fetch, XHR — is counted read/write the same
// way http-log.ts counts `ctx.request()` calls, but deliberately never
// appended to http.jsonl. That file is `ctx.request()`'s own record
// (docs/spec.md "Receipts"); widening its meaning to include page traffic
// nukadoko never asserted the shape of would be a different, larger change
// than this task's spec asks for. The subscription is set up once, at
// context creation, and lives for the context's whole lifetime — it is
// `observed`'s own `reset()` (create-context.ts's `beginStep`) that advances
// the step boundary, not resubscribing.

export interface LaunchBrowserOptions {
  /** Maps to `config.browser.headless`, default true. */
  headless: boolean;
  /** Where trace.zip and screenshot(s) are written. Must already exist. */
  evidenceDir: string;
  /** Restores a `--session`'s prior storageState, when one was loaded;
   * `undefined` for a session's first-ever use or when `--session` wasn't
   * given at all. */
  storageState?: StorageState;
  /** Tallies every request this browser context's page(s) make — see this
   * module's header comment. */
  observed: ObservedCollector;
}

export interface BrowserEvidenceHandle {
  readonly page: Page;
  /** Snapshot of the browser context's current storageState, for the
   * executor to persist as the session's new state. Must be called *before*
   * `finalize()` (which closes the context) — collected on a still-open
   * context is the only way `context.storageState()` can succeed at all.
   * Swallows failures (returns `undefined`) rather than throwing: a step can
   * reach the browser via `ctx.page()` and close or crash it before
   * returning, and losing this snapshot must not cost the receipt (or, per
   * docs/spec.md's sessions design, force the session's file to be deleted —
   * `undefined` here means create-context.ts's `dispose` leaves the
   * existing session file untouched). */
  collectStorageState(): Promise<StorageState | undefined>;
  /** Stops tracing, saves trace.zip, captures screenshot(s), and closes the
   * browser. Returns the screenshot file names actually written (best
   * effort: a screenshot failure here must never mask the step's real
   * outcome, so it is swallowed rather than thrown). */
  finalize(status: "ok" | "failed"): Promise<string[]>;
}

export async function launchBrowserWithTracing(
  options: LaunchBrowserOptions,
): Promise<BrowserEvidenceHandle> {
  const browser: Browser = await chromium.launch({ headless: options.headless });
  const context: BrowserContext = await browser.newContext(
    options.storageState ? { storageState: options.storageState } : {},
  );
  context.on("request", (request) => {
    options.observed.record(request.method());
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  async function collectStorageState(): Promise<StorageState | undefined> {
    try {
      return await context.storageState();
    } catch {
      // See doc comment above.
      return undefined;
    }
  }

  async function finalize(status: "ok" | "failed"): Promise<string[]> {
    const screenshots: string[] = [];
    try {
      const buffer = await page.screenshot();
      await writeFile(path.join(options.evidenceDir, "final.png"), buffer);
      screenshots.push("final.png");
      // "final.png" is always saved; on failure it is additionally saved
      // again as "failure.png" so a failed receipt's evidence is easy to
      // spot without opening every screenshot to find the relevant one.
      if (status === "failed") {
        await writeFile(path.join(options.evidenceDir, "failure.png"), buffer);
        screenshots.push("failure.png");
      }
    } catch {
      // The page may already be closed or otherwise unusable after a failed
      // run; losing a screenshot is not a reason to also lose the receipt.
    }
    // Same reasoning for the three teardown calls below: a step can reach
    // the browser via ctx.page() and close (or crash) it before throwing, so
    // tracing.stop/context.close/browser.close can each fail on an already-
    // gone context/browser. A missing trace.zip or a browser left half-torn-
    // down is not a reason to also lose the receipt, so each is swallowed
    // independently and best-effort teardown continues.
    try {
      await context.tracing.stop({ path: path.join(options.evidenceDir, "trace.zip") });
    } catch {
      // See comment above.
    }
    try {
      await context.close();
    } catch {
      // See comment above.
    }
    try {
      await browser.close();
    } catch {
      // See comment above.
    }
    return screenshots;
  }

  return { page, collectStorageState, finalize };
}
