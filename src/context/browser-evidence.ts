import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  ConsoleMessage,
  LaunchOptions,
  Page,
  Request as PlaywrightRequest,
  WebError,
} from "playwright";
import type { ScreenshotEntry } from "../record/types.js";
import type { SecretSet } from "../secrets/types.js";
import type { HttpLogFailedCollector } from "./http-log-failed.js";
import type { HttpOmittedCollector } from "./http-omitted.js";
import { instrumentApiRequestContext } from "./http-log.js";
import { loadPlaywright } from "./load-playwright.js";
import type { ObservedCollector } from "./observed.js";
import type { PageEventsCollector } from "./page-events.js";
import { subscribePageHttpLogging } from "./page-http-log.js";

// Responsibility: the Playwright side of evidence collection when a step
// calls `ctx.page()` or `pageAs()`: launch the configured browser engine (chromium by
// default), trace each browser context, and capture a screenshot of each at
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
// information `record.status` didn't already carry, and because `finalize`
// only ever runs after `run` has returned or thrown, it could be seconds
// stale relative to the failure it was named for — a real run once measured
// an ~8s gap, leaving `status: "failed"` sitting next to a screenshot that
// showed the target present, and that pairing was read as "state is
// flickering" when it was actually "these two facts are 8 seconds apart and
// nothing said so". One screenshot, always named `final.png`, with its own
// `at` (see `ScreenshotEntry`, src/record/types.ts) is what replaces it:
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
// That listener does not see `page.request` or `context.request`. Those
// are one APIRequestContext Playwright hangs on the browser context, and
// its calls never emit `request`. `instrumentApiRequestContext`
// (http-log.ts) logs that object in place, once, at the same moment the
// listener is attached, so a step that destructures `page` or `context`
// and calls `.request.post` / `.request.delete` still lands on `observed`
// and http.jsonl. A later page copies the same reference, so it is
// already covered. GET and HEAD stay reads, the same classification
// `ctx.request()` already uses.
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
// instead, so `evidence.trace` on a step record is that step's own window, not
// the whole scenario's — a step that failed can be opened directly instead
// of scrubbed for out of one long recording (measured directly:
// `tracing.stop()` throws once a chunk has been used at all, so the two
// shapes cannot coexist; the single scenario-long trace is retired, not
// merely supplemented). `startChunk({ title })`'s own
// `title` lands on the trace's `context-options` entry (also measured), so
// each chunk names the step it came from without create-context.ts writing
// that anywhere else.
//
// `LaunchBrowserOptions.browserType` is what lets a
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
// what actually ran is trustworthy enough to record: a declared browser and
// the one that launched can differ. An engine
// whose binary was never installed (`npx playwright install firefox`/
// `webkit`) fails right here, at `launch` — Playwright's own error, neither
// caught nor reworded, since it already names the missing engine as part of
// the executable path it looked for.
//
// One browser, several contexts. `launchBrowser` starts the engine once per
// `ctx`, and `openTracedContext` gives each browser context its own
// instrumentation: the default context `page` belongs to, and one per
// `pageAs(name)` (docs/spec.md "Context API"). Every subscription above is
// per context, because Playwright emits `request`, `console`, and the rest
// on the context that owns the page, and tracing is per context too. Each
// context therefore records into the same collectors, its own trace chunks,
// and its own final screenshot. `as` is the context's name on every entry
// it writes, absent for the default context.
export type BrowserEngineName = "chromium" | "firefox" | "webkit";

export interface LaunchBrowserOptions {
  /** `config.browserType` (config/schema.ts), naming which of `chromium`/
   * `firefox`/`webkit` to launch. `undefined` behaves exactly like
   * `"chromium"`, the default. */
  browserType?: BrowserEngineName;
  /** What asked for the browser (a step's text, or `ctx.page()` when no step
   * is named), for the one-line error a project without `playwright`
   * installed sees (load-playwright.ts). */
  neededBy: string;
  /** `config.browser` (config/schema.ts) as a config author wrote it,
   * passed straight through to the selected engine's own `launch`.
   * `undefined` when a project sets no `browser` at all; passing `undefined`
   * to `launch` is the same as omitting the argument, so Playwright's own
   * default (`headless: true`) applies exactly as it would without nukadoko
   * in between. */
  browser?: LaunchOptions;
}

export interface BrowserHandle {
  /** The engine and version this handle actually launched — read once,
   * from the real `Browser` object, right after `launch` resolved (this
   * file's own header). Never derived from `options.browserType`, which
   * only says what was *asked* for. */
  readonly browserInfo: { readonly type: string; readonly version: string };
  /** Opens one instrumented browser context in this browser. */
  openTracedContext(options: TracedContextOptions): Promise<TracedContextHandle>;
  /** Closes the browser. Swallows its own failure, the same as
   * `TracedContextHandle.finalize`: a browser already gone is not a reason
   * to lose a record. */
  close(): Promise<void>;
}

export interface TracedContextOptions {
  /** The `pageAs(name)` name, or `undefined` for the default context. Copied
   * onto every page event and http.jsonl entry this context records, and
   * into its file names (context-name.ts's `contextFileName`). */
  as?: string;
  /** Passed straight to `browser.newContext`. The caller merges
   * `config.browserContext`, `baseURL`, and a `pageAs`
   * call's own options into it; this module adds nothing of its own. */
  contextOptions: BrowserContextOptions;
  /** Where the final screenshot is written. Must already exist. */
  evidenceDir: string;
  /** Tallies every request this context's page(s) make (this file's own
   * header). */
  observed: ObservedCollector;
  /** Records console errors, uncaught page errors, and failed requests this
   * context's page(s) produce (this file's own header). */
  pageEvents: PageEventsCollector;
  /** Where this ctx's http.jsonl currently lives. A getter, not a fixed
   * path, for the same reason http-log.ts's own `logPath` is one: create-
   * context.ts's `beginStep` redirects it at each step boundary.
   * page-http-log.ts reads it when a page request starts, so a response
   * that lands after the next boundary still appends to the step that
   * sent the request. */
  logPath: () => string;
  /** Values page-issued http.jsonl entries must redact, the same
   * `SecretSet` http-log.ts's own `ctx.request()` wrapper receives. */
  secrets: SecretSet;
  /** Tallies every page-issued request left out of http.jsonl, by
   * `request.resourceType()` (http-omitted.ts). */
  httpOmitted: HttpOmittedCollector;
  /** Tallies every page-issued http.jsonl line whose append failed
   * (http-log-failed.ts). */
  httpLogFailed: HttpLogFailedCollector;
}

export interface TracedContextHandle {
  readonly page: Page;
  /** Opens a new trace chunk (`tracing.startChunk({ title })`); `title`
   * lands on the chunk's own `context-options` entry. Must not be called
   * while a chunk is already open. A failure here is not swallowed: it
   * propagates out of the `ctx.page()`/`pageAs()` call that triggered it,
   * since a chunk that failed to open leaves that caller nothing to
   * continue on. */
  beginStepChunk(title: string): Promise<void>;
  /** Closes the open trace chunk (`tracing.stopChunk({ path })`), writing it
   * to `path`. Swallows its own failure: losing one step's trace chunk must
   * not cost that step's step record. */
  endStepChunk(path: string): Promise<void>;
  /** Waits for every page-issued http.jsonl append this context has kicked
   * off *so far* to settle (page-http-log.ts's `PageHttpLogHandle.flush`). */
  flushPageHttpLog(): Promise<void>;
  /** Captures the final screenshot as `fileName` in `evidenceDir` and
   * closes the context. Returns the screenshot actually written, at most
   * one (best effort: a screenshot failure here must never mask the step's
   * real outcome, so it is swallowed rather than thrown). Whatever chunk is
   * still open is the caller's to have closed via `endStepChunk` first. */
  finalize(fileName: string): Promise<ScreenshotEntry[]>;
}

export async function launchBrowser(options: LaunchBrowserOptions): Promise<BrowserHandle> {
  // Loaded here, not at module load: `playwright` is an optional peer
  // (load-playwright.ts), and a project that never builds a browser fixture
  // never reaches this line.
  const playwright = await loadPlaywright(options.neededBy);
  const engine = playwright[options.browserType ?? "chromium"];
  const browser: Browser = await engine.launch(options.browser);
  return {
    browserInfo: { type: browser.browserType().name(), version: browser.version() },
    openTracedContext: (contextOptions) => openTracedContext(browser, contextOptions),
    async close(): Promise<void> {
      try {
        await browser.close();
      } catch {
        // See the interface's own doc comment above.
      }
    },
  };
}

async function openTracedContext(browser: Browser, options: TracedContextOptions): Promise<TracedContextHandle> {
  const { as } = options;
  const context: BrowserContext = await browser.newContext(options.contextOptions);
  // `tracing.start` and `newPage` can throw after the context exists (an
  // invalid viewport is rejected by `newPage`, not by `newContext`). Close
  // the context before the error propagates, or it stays open in a browser
  // that later contexts of this scenario share.
  try {
    context.on("request", (request) => {
      options.observed.record(request.method());
    });
    // Not the listener above: `page.request` / `context.request` do not emit
    // `request` (this file's own header). One call covers every page, because
    // they share this object.
    instrumentApiRequestContext(
      context.request,
      options.logPath,
      options.secrets,
      options.observed,
      options.httpLogFailed,
      as,
    );
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
        ...(as !== undefined ? { as } : {}),
      });
    });
    context.on("weberror", (webError) => {
      options.pageEvents.recordPageError(webError.error().message, as);
    });
    context.on("requestfailed", (request) => {
      const failure = request.failure();
      options.pageEvents.recordFailedRequest({
        method: request.method(),
        url: request.url(),
        ...(failure ? { failure: failure.errorText } : {}),
        ...(as !== undefined ? { as } : {}),
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
      options.httpLogFailed,
      as,
    );
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();

    return {
      page,
      async beginStepChunk(title: string): Promise<void> {
        // Not swallowed: see the interface's own doc comment above.
        await context.tracing.startChunk({ title });
      },
      async endStepChunk(filePath: string): Promise<void> {
        try {
          await context.tracing.stopChunk({ path: filePath });
        } catch {
          // See the interface's own doc comment above.
        }
      },
      async flushPageHttpLog(): Promise<void> {
        await pageHttpLog.flush();
      },
      async finalize(fileName: string): Promise<ScreenshotEntry[]> {
        const screenshots: ScreenshotEntry[] = [];
        try {
          const buffer = await page.screenshot();
          // Taken right when the screenshot itself resolved (this file's own
          // header), not after the write below, which measures disk I/O
          // rather than the moment the page was captured.
          const at = new Date().toISOString();
          await writeFile(path.join(options.evidenceDir, fileName), buffer);
          screenshots.push({ file: fileName, at, ...(as !== undefined ? { as } : {}) });
        } catch {
          // The page may already be closed or otherwise unusable after a
          // failed run; losing a screenshot is not a reason to also lose the
          // step record.
        }
        // A step can close (or crash) the context before throwing, so this
        // can fail on a context already gone. That is not a reason to lose
        // the step record either.
        try {
          await context.close();
        } catch {
          // See comment above.
        }
        return screenshots;
      },
    };
  } catch (error) {
    try {
      await context.close();
    } catch {
      // A close that itself fails must not replace the error that aborted
      // the setup. The caller needs the reason `tracing.start` or `newPage`
      // failed.
    }
    throw error;
  }
}
