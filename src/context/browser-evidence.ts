import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";
import type { ScreenshotEntry } from "../receipt/types.js";
import type { SecretSet } from "../secrets/types.js";
import type { StorageState } from "../session/storage-state.js";
import type { HttpOmittedCollector } from "./http-omitted.js";
import type { ObservedCollector } from "./observed.js";
import type { PageEventsCollector } from "./page-events.js";
import { subscribePageHttpLogging } from "./page-http-log.js";

// Responsibility: the Playwright side of evidence collection when a step
// calls `ctx.page()` — launch the configured browser engine (chromium by
// default), trace the whole browser context, and capture a screenshot at
// the end — kept separate from
// context/create-context.ts so that module isn't also responsible for
// Playwright's specific launch/newContext/tracing/newPage lifecycle and its
// mirrored teardown. `finalize` is never reachable from a step's `run`: only
// create-context.ts's `dispose` (executor-only) calls it, after `run` has
// already returned or thrown.
//
// `finalize` takes no `status` argument — it used to write the same
// screenshot buffer a second time, under a
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
// `observed`: every request the page itself issues — navigation, fetch,
// XHR — is counted read/write the
// same way http-log.ts counts `ctx.request()` calls. `observed` keeps
// counting every one of them regardless of what the second subscription
// below goes on to do with it — the two are deliberately different tallies
// (http-omitted.ts's own header). The subscription above is set up once, at
// context creation, and lives for the context's whole lifetime — it is
// `observed`'s own `reset()` (create-context.ts's `beginStep`) that advances
// the step boundary, not resubscribing.
//
// A second, separate subscription — `subscribePageHttpLogging`
// (page-http-log.ts), wired in below — is what now also appends page-issued
// traffic to http.jsonl itself: document/xhr/fetch responses only, each
// entry marked `via: "page"` so it reads apart
// from `ctx.request()`'s own `via: "request"` entries on the same file.
// Everything else (image/stylesheet/script/...) is tallied into
// `httpOmitted` instead of landing on the file at all, so a step's own
// dropped count is never silent (create-context.ts's own
// `httpOmittedSnapshot`). Kept in its own module rather than folded into
// this one: it owns its own resourceType allowlist and its own start-time
// bookkeeping, neither of which this file's other event subscriptions need.
//
// `console`/`weberror`/`requestfailed` are subscribed the same way, into
// `pageEvents` — a green step can still be sitting on top of a broken
// page, and cucumber-js has no browser context of its own to have ever
// recorded that from. Subscribed on `context`, not
// `page`, for the same "outlives a future page-fixture override" reason
// `observed`'s own `request` subscription is (src/context/page-events.ts's
// own header). `console` is filtered to `msg.type() === "error"` right here
// — a warning is routine SPA noise, not evidence — the other two categories
// have no such filter: every `weberror`/`requestfailed` is worth recording.
//
// `beginStepChunk`/`endStepChunk` replace the former "one trace.zip per
// context" shape: `tracing.start()` below still opens one tracing session
// for this handle's whole lifetime (a chunk needs a started session to
// begin from), but nothing is ever written from it directly any more.
// create-context.ts opens and closes a chunk at each step boundary
// instead, so `evidence.trace` on a receipt is that step's own window, not
// the whole scenario's — a step that failed can be opened directly instead
// of scrubbed for out of one long recording (measured directly:
// `tracing.stop()` throws once a chunk has been used at all, so the two
// shapes cannot coexist; the single scenario-long trace is retired, not
// merely supplemented). `startChunk({ title })`'s own
// `title` lands on the trace's `context-options` entry (also measured), so
// each chunk names the step it came from without create-context.ts writing
// that anywhere else.
//
// `BROWSER_ENGINES` and `LaunchBrowserOptions.browserType` are what let a
// project pick firefox or webkit instead of chromium: `chromium`/`firefox`/
// `webkit` are three separate namespaces
// Playwright exports, each with its own `launch`, so "which engine" is
// answered by which namespace's `launch` gets called here, not by an option
// passed to it (`LaunchOptions` itself has no such key; see config/
// schema.ts's own `browserType` doc comment). `browserInfo`, read off the
// real `Browser` object right after `launch` resolves
// (`Browser#browserType().name()` / `Browser#version()`), is the measured
// counterpart create-context.ts's `dispose()` hands to `ScenarioRecord.
// browser` — never `options.browserType` itself, since a step can override
// the `page` fixture with a browser this handle never launched, and only
// what actually ran is trustworthy enough to record (docs/spec.md
// "Declaration and measurement answer different questions"). An engine
// whose binary was never installed (`npx playwright install firefox`/
// `webkit`) fails right here, at `launch` — Playwright's own error, neither
// caught nor reworded, since it already names the missing engine as part of
// the executable path it looked for.
const BROWSER_ENGINES = { chromium, firefox, webkit } as const;

export type BrowserEngineName = keyof typeof BROWSER_ENGINES;

export interface LaunchBrowserOptions {
  /** `config.browserType` (config/schema.ts), naming which of `chromium`/
   * `firefox`/`webkit` to launch. `undefined` behaves exactly like
   * `"chromium"` — the previous default, before this option existed — so
   * a caller that never wires this in (existing tests, `nuka do`'s own
   * defaults) keeps launching what it always has. */
  browserType?: BrowserEngineName;
  /** `config.browser` (config/schema.ts) as a config author wrote it,
   * passed straight through to the selected engine's own `launch`
   * (widened from always-chromium to whichever `browserType` above
   * names) — this module no longer picks `headless` out of it itself.
   * `undefined` when a project sets no `browser` at all; passing `undefined`
   * to `launch` is the same as omitting the argument, so Playwright's own
   * default (`headless: true`) applies exactly as it would without nukadoko
   * in between. */
  browser?: LaunchOptions;
  /** `config.browserContext` (config/schema.ts), passed straight through to
   * `browser.newContext`. `storageState` and `baseURL` below are spread in
   * *after* this, not before: schema.ts
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
  /** Where this ctx's http.jsonl currently lives — a getter, not a fixed
   * path, for the same reason http-log.ts's own `logPath` is one: create-
   * context.ts's `beginStep` redirects it at each step boundary, and
   * page-http-log.ts's subscription (below) must always read whichever
   * directory is *current* when a response actually arrives, not the one
   * that was current when the browser was first launched. */
  logPath: () => string;
  /** Values page-issued http.jsonl entries must redact — the same
   * `SecretSet` http-log.ts's own `ctx.request()` wrapper already
   * receives. */
  secrets: SecretSet;
  /** Tallies every page-issued request left out of http.jsonl — an
   * image/stylesheet/script/etc, by `request.resourceType()` (this file's
   * own header, and http-omitted.ts's). */
  httpOmitted: HttpOmittedCollector;
  /** `config.baseURL`, wired into the browser context so `page.goto("/path")`
   * resolves against it (docs/spec.md "Context API"). Omitted from
   * `newContext` when unset — Playwright's own default for an unset
   * `baseURL` (relative navigation stays an error) is preferable to nukadoko
   * inventing one. */
  baseURL?: string;
}

export interface BrowserEvidenceHandle {
  readonly page: Page;
  /** The engine and version this handle actually launched — read once,
   * from the real `Browser` object, right after `launch` resolved (this
   * file's own header). create-context.ts's
   * `dispose()` hands this straight to `ScenarioRecord.browser` when this
   * handle exists at all; it is never derived from `options.browserType`,
   * which only says what was *asked* for. */
  readonly browserInfo: { readonly type: string; readonly version: string };
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
  /** Opens a new trace chunk (`tracing.startChunk({ title })`) — `title`
   * lands on the chunk's own `context-options` entry (this file's own
   * header). Executor-only, called from create-context.ts, never from a
   * step's own `ctx`. Must not be called while a chunk is already open
   * (create-context.ts's own `chunkOpen` bookkeeping is what keeps that
   * true); unlike `endStepChunk` below, a failure here is not swallowed —
   * it propagates out of whichever `ctx.page()` call triggered it, the same
   * way a `launchBrowserWithTracing` failure already does, since a chunk
   * that failed to open leaves nothing for `ctx.page()`'s own caller to
   * usefully continue on. */
  beginStepChunk(title: string): Promise<void>;
  /** Closes the currently open trace chunk (`tracing.stopChunk({ path })`),
   * writing it to `path`. Executor-only; only ever called when a chunk is
   * actually open. Swallows its own failure — the same fault-tolerance
   * `finalize`'s own teardown calls already have, and for the same reason:
   * losing one step's own trace chunk must not cost that step's receipt
   * (docs/spec.md's "measurement must never break execution"). */
  endStepChunk(path: string): Promise<void>;
  /** Waits for every page-issued http.jsonl append this handle's own
   * `subscribePageHttpLogging` subscription has kicked off *so far* to
   * settle (page-http-log.ts's own `PageHttpLogHandle.flush`) — each append
   * fires from inside a `response` event handler with no caller of its own
   * to await it, unlike `ctx.request()`'s own entries. Executor-only,
   * called from create-context.ts's `closeCurrentChunk` at the same step
   * boundary that already closes this step's own trace chunk, *before*
   * anything downstream reads http.jsonl for that boundary. A no-op cost,
   * not merely a no-op call, when nothing is in flight: `Promise.all([])`
   * resolves immediately. */
  flushPageHttpLog(): Promise<void>;
  /** Captures the final screenshot and closes the context and browser.
   * Returns the screenshot(s) actually written — at most one, `final.png`
   * (best effort: a screenshot failure here must never mask the step's real
   * outcome, so it is swallowed rather than thrown). No longer calls
   * `tracing.stop()` (this file's own header: that call fails once a chunk
   * has been used) — whatever chunk is still open when this runs is the
   * caller's own responsibility to have already closed via `endStepChunk`,
   * same as create-context.ts's `dispose()` does. */
  finalize(): Promise<ScreenshotEntry[]>;
}

export async function launchBrowserWithTracing(
  options: LaunchBrowserOptions,
): Promise<BrowserEvidenceHandle> {
  // `browserType ?? "chromium"` (this file's own header) is the whole
  // selection: every other caller keeps launching chromium exactly as
  // before, since `undefined` and `"chromium"` land on the same namespace.
  const engine = BROWSER_ENGINES[options.browserType ?? "chromium"];
  const browser: Browser = await engine.launch(options.browser);
  // Measured, not declared (this file's own header) — read once, right
  // after `launch` resolved, from the `Browser` object itself.
  const browserInfo = { type: browser.browserType().name(), version: browser.version() };
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
  // A second, separate subscription (this file's own header) — appends
  // page-issued document/xhr/fetch traffic to http.jsonl itself, and tallies
  // everything else into `httpOmitted` instead.
  const pageHttpLog = subscribePageHttpLogging(
    context,
    options.logPath,
    options.secrets,
    options.httpOmitted,
  );
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

  async function beginStepChunk(title: string): Promise<void> {
    // Not swallowed — see the interface's own doc comment above for why.
    await context.tracing.startChunk({ title });
  }

  async function endStepChunk(filePath: string): Promise<void> {
    try {
      await context.tracing.stopChunk({ path: filePath });
    } catch {
      // See the interface's own doc comment above.
    }
  }

  async function flushPageHttpLog(): Promise<void> {
    await pageHttpLog.flush();
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
    // Same reasoning for the two teardown calls below: a step can reach the
    // browser via ctx.page() and close (or crash) it before throwing, so
    // context.close/browser.close can each fail on an already-gone context/
    // browser. A browser left half-torn-down is not a reason to also lose
    // the receipt, so each is swallowed independently and best-effort
    // teardown continues. `tracing.stop()` is deliberately not called here
    // any more (this file's own header) — the caller (create-context.ts's
    // `dispose`) already closed whatever chunk was open via `endStepChunk`
    // before calling this.
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

  return {
    page,
    browserInfo,
    collectStorageState,
    beginStepChunk,
    endStepChunk,
    flushPageHttpLog,
    finalize,
  };
}
