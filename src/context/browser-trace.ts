import type { BrowserContext, CDPSession, Page } from "playwright";
import { stampsUrl, TRACEPARENT } from "./trace-context.js";

// Responsibility: put a `traceparent` header on each request a Chromium
// page sends to the world's origin (docs/spec.md "Trace context and the
// program's log"), so the program's log can say which step a page request
// came from. Boundary:
// one browser context's pages; the value, and which URLs get one, are the
// recorder's (observed.ts, trace-context.ts).
//
// It uses the Chrome DevTools Protocol's Fetch domain on a session of its
// own for each page, with patterns that match only the world's origin: a
// paused request continues at once with the header added. Playwright
// offers two ways that do not fit. Measured on Chromium 149.0.7827.55
// with Playwright 1.61.1, a page that loads an image with
// `cache-control: max-age=3600`, navigated to twice, then a page on a
// second origin that fetches from the world, which answers simple CORS
// requests only:
//
// - `context.setExtraHTTPHeaders` sent the header to the second origin
//   too, and the cross-origin fetch to the world became a preflight
//   `OPTIONS` request, which failed, so the page's fetch failed.
// - `context.route` made the second navigation load the image again:
//   Playwright turns the browser's HTTP cache off while a route exists, so
//   that every request reaches the route's handler. The scenario then
//   measures a page that differs from the one a person gets.
// - This session loaded the image once, sent the cross-origin fetch with
//   no preflight, kept the page's cookies, and left a route the step adds
//   itself (`fulfill` or `continue`) working.
//
// Only a document, a `fetch`, an XMLHttpRequest, and an EventSource are
// stamped: the requests whose answer a program logs as a request of its
// own, and the kinds page-http-log.ts writes to http.jsonl. Each paused
// request costs a round trip to this process, 2 to 3 ms in the
// measurement above, so a page's images, scripts, and stylesheets are left
// out of the patterns. The patterns name no `EventSource` type: the Fetch
// domain pauses a page's `fetch` and its EventSource as `XHR` (measured on
// Chromium 141.0.7390.37 and 153.0.8010.12), and Chromium 141 refuses the
// whole registration over that one name ("Unknown resource type in fetch
// filter: 'EventSource'"), which left every request of every page
// unstamped.
//
// A session that cannot be opened or registered is not silent: each step
// whose page then sends a request of those kinds to the world gets one
// unmeasured `page_request` entry with the reason. A page that closed in
// between sends nothing more, so it never gets one.
//
// Firefox and WebKit have no such protocol through Playwright, so their
// page requests go without the header; the requests a step sends from its
// own process are stamped on every engine. A request a page sends before
// its session is attached goes without one too: a popup's first requests,
// since the popup is already loading when the context announces it. A page
// the step opens with `context.newPage()` is attached before the call
// returns (browser-evidence.ts).

/** What the stamping asks of the recorder. */
export interface PageStamp {
  /** The world's origin, which the Fetch patterns match. */
  readonly origin: string;
  /** The `traceparent` for a request to `url`, counted as sent, or
   * `undefined` when it is not the world's. */
  traceparentFor(url: string): string | undefined;
  /** Records that a request a page sent to the world went without a
   * `traceparent`, for the reason `detail` names. */
  unstamped(detail: string): void;
}

/** CDP's Fetch.requestPaused event, the members read here. */
interface RequestPaused {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
}

/** The Fetch URL patterns for every URL of the world at `origin`: its
 * own, and, for a world at `localhost`, every name below it at the same
 * port (trace-context.ts). `*` and `?` are wildcards there and `\`
 * escapes, so each is escaped in the origin. */
export function fetchPatternsOf(origin: string): string[] {
  const escape = (text: string): string => text.replace(/[\\*?]/g, (character) => `\\${character}`);
  const world = new URL(origin);
  const below = world.hostname === "localhost" ? [`${world.protocol}//*.localhost${world.port === "" ? "" : `:${world.port}`}/*`] : [];
  return [`${escape(origin)}/*`, ...below];
}

/** The resource types the Fetch patterns name (this file's own header). */
const STAMPED_TYPES = ["Document", "Fetch", "XHR"] as const;

/** The same requests, by Playwright's `request.resourceType()`. */
const STAMPED_KINDS: ReadonlySet<string> = new Set(["document", "fetch", "xhr", "eventsource"]);

/** Starts stamping every page of `context`, the ones it has and the ones
 * it opens, and returns what attaches a page the caller opened, so the
 * caller can wait for it before the page's first request. Does nothing for
 * an engine other than Chromium. */
export function stampPageRequests(context: BrowserContext, engine: string, stamp: PageStamp): { attach(page: Page): Promise<void> } {
  if (engine !== "chromium") return { attach: async () => undefined };
  const attached = new WeakMap<Page, Promise<void>>();
  // Why each page whose session failed sends its requests without a header.
  const unstamped = new WeakMap<Page, string>();
  const attach = (page: Page): Promise<void> => {
    const known = attached.get(page);
    if (known !== undefined) return known;
    const done = attachPage(context, page, stamp).then((failure) => {
      if (failure !== undefined) unstamped.set(page, `requests a page sends to the world go without a traceparent: ${failure}`);
    });
    attached.set(page, done);
    return done;
  };
  context.on("request", (request) => {
    if (!STAMPED_KINDS.has(request.resourceType()) || !stampsUrl(stamp.origin, request.url())) return;
    let page: Page;
    try {
      page = request.frame().page();
    } catch {
      // A service worker's request has no frame, and no page session sees it.
      return;
    }
    const detail = unstamped.get(page);
    if (detail !== undefined) stamp.unstamped(detail);
  });
  context.on("page", (page) => {
    void attach(page);
  });
  for (const page of context.pages()) void attach(page);
  return { attach };
}

/** Opens `page`'s session and registers its patterns; the error's message
 * when either fails. */
async function attachPage(context: BrowserContext, page: Page, stamp: PageStamp): Promise<string | undefined> {
  let session: CDPSession;
  try {
    session = await context.newCDPSession(page);
  } catch (error) {
    return messageOf(error);
  }
  session.on("Fetch.requestPaused", (event: RequestPaused) => {
    let headers: { name: string; value: string }[] | undefined;
    try {
      const own = Object.keys(event.request.headers).some((name) => name.toLowerCase() === TRACEPARENT);
      const traceparent = own ? undefined : stamp.traceparentFor(event.request.url);
      if (traceparent !== undefined) {
        headers = [...Object.entries(event.request.headers).map(([name, value]) => ({ name, value })), { name: TRACEPARENT, value: traceparent }];
      }
    } catch {
      headers = undefined;
    }
    // Continued whatever happened above: a paused request nobody continues
    // never completes, and the page would hang on it.
    session.send("Fetch.continueRequest", { requestId: event.requestId, ...(headers === undefined ? {} : { headers }) }).catch(() => undefined);
  });
  try {
    await session.send("Fetch.enable", {
      patterns: fetchPatternsOf(stamp.origin).flatMap((urlPattern) =>
        STAMPED_TYPES.map((resourceType) => ({ urlPattern, resourceType, requestStage: "Request" as const })),
      ),
    });
  } catch (error) {
    return messageOf(error);
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
