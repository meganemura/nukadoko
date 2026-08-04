import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";
import type { ScreenshotEntry } from "../receipt/types.js";
import type { StorageState } from "../session/storage-state.js";
import type { ObservedCollector } from "./observed.js";
import type { PageEventsCollector } from "./page-events.js";

// Responsibility: the Playwright side of evidence collection when a step
// calls `ctx.page()` — launch chromium, trace the whole browser context,
// and capture a screenshot at the end — kept separate from
// context/create-context.ts so that module isn't also responsible for
// Playwright's specific launch/newContext/tracing/newPage lifecycle and its
// mirrored teardown. `finalize` is never reachable from a step's `run`: only
// create-context.ts's `dispose` (executor-only) calls it, after `run` has
// already returned or thrown.
//
// `finalize` takes no `status` argument (fb4-evidence-time task spec, item
// 1) — it used to write the same screenshot buffer a second time, under a
// second name, whenever `status === "failed"`. That second file carried no
// information `receipt.status` didn't already carry, and because `finalize`
// only ever runs after `run` has returned or thrown, it could be seconds
// stale relative to the failure it was named for — a real run once measured
// an ~8s gap, leaving `status: "failed"` sitting next to a screenshot that
// showed the target present, and that pairing was read as "state is
// flickering" when it was actually "these two facts are 8 seconds apart and
// nothing said so". One screenshot, always named `final.png`, with its own
// `at` (see `ScreenshotEntry`, src/receipt/types.ts) is what replaces it:
// the timestamp is the information a second file was standing in for
// without ever stating it.
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
//
// `console`/`weberror`/`requestfailed` are subscribed the same way, into
// `pageEvents` (P0-page-events task spec) — a green step can still be
// sitting on top of a broken page, and cucumber-js has no browser context of
// its own to have ever recorded that from. Subscribed on `context`, not
// `page`, for the same "outlives a future page-fixture override" reason
// `observed`'s own `request` subscription is (src/context/page-events.ts's
// own header). `console` is filtered to `msg.type() === "error"` right here
// — a warning is routine SPA noise, not evidence — the other two categories
// have no such filter: every `weberror`/`requestfailed` is worth recording.

export interface LaunchBrowserOptions {
  /** `config.browser` (config/schema.ts) as a config author wrote it,
   * passed straight through to `chromium.launch` (t6-config-browser task
   * spec, decision 4) — this module no longer picks `headless` out of it
   * itself. `undefined` when a project sets no `browser` at all; passing
   * `undefined` to `chromium.launch` is the same as omitting the argument,
   * so Playwright's own default (`headless: true`) applies exactly as it
   * would without nukadoko in between. */
  browser?: LaunchOptions;
  /** `config.browserContext` (config/schema.ts), passed straight through to
   * `browser.newContext` (context-options task spec). `storageState` and
   * `baseURL` below are spread in *after* this, not before: schema.ts
   * already rejects a `browserContext` that sets either key, so the two
   * never actually collide, but keeping nukadoko's own values last is a
   * cheap second line of defense against that invariant ever slipping. */
  browserContext?: BrowserContextOptions;
  /** Where trace.zip and screenshot(s) are written. Must already exist. */
  evidenceDir: string;
  /** Restores a `--session`'s prior storageState, when one was loaded;
   * `undefined` for a session's first-ever use or when `--session` wasn't
   * given at all. */
  storageState?: StorageState;
  /** Tallies every request this browser context's page(s) make — see this
   * module's header comment. */
  observed: ObservedCollector;
  /** Records console errors, uncaught page errors, and failed requests this
   * browser context's page(s) produce — see this module's header comment. */
  pageEvents: PageEventsCollector;
  /** `config.baseURL`, wired into the browser context so `page.goto("/path")`
   * resolves against it (docs/spec.md "Context API"). Omitted from
   * `newContext` when unset — Playwright's own default for an unset
   * `baseURL` (relative navigation stays an error) is preferable to nukadoko
   * inventing one. */
  baseURL?: string;
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
  /** Stops tracing, saves trace.zip, captures the final screenshot, and
   * closes the browser. Returns the screenshot(s) actually written — at
   * most one, `final.png` (best effort: a screenshot failure here must never
   * mask the step's real outcome, so it is swallowed rather than thrown). */
  finalize(): Promise<ScreenshotEntry[]>;
}

export async function launchBrowserWithTracing(
  options: LaunchBrowserOptions,
): Promise<BrowserEvidenceHandle> {
  const browser: Browser = await chromium.launch(options.browser);
  const context: BrowserContext = await browser.newContext({
    ...(options.browserContext ?? {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  context.on("request", (request) => {
    options.observed.record(request.method());
  });
  context.on("console", (msg) => {
    if (msg.type() !== "error") {
      return;
    }
    const location = msg.location();
    options.pageEvents.recordConsoleError({
      text: msg.text(),
      location: {
        url: location.url,
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      },
    });
  });
  context.on("weberror", (webError) => {
    options.pageEvents.recordPageError(webError.error().message);
  });
  context.on("requestfailed", (request) => {
    const failure = request.failure();
    options.pageEvents.recordFailedRequest({
      method: request.method(),
      url: request.url(),
      ...(failure ? { failure: failure.errorText } : {}),
    });
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

  async function finalize(): Promise<ScreenshotEntry[]> {
    const screenshots: ScreenshotEntry[] = [];
    try {
      const buffer = await page.screenshot();
      // Taken right when the screenshot itself resolved (this file's own
      // header) — not after the write below, which measures disk I/O rather
      // than the moment the page was actually captured.
      const at = new Date().toISOString();
      await writeFile(path.join(options.evidenceDir, "final.png"), buffer);
      screenshots.push({ file: "final.png", at });
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
