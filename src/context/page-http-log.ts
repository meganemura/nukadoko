import type { BrowserContext, Request as PlaywrightRequest } from "playwright";
import type { SecretSet } from "../secrets/types.js";
import { appendHttpLogEntry } from "./http-log.js";
import type { HttpOmittedCollector } from "./http-omitted.js";

// Responsibility: the page-origin half of http.jsonl (p3b-page-network task
// spec) — everything a step's `ctx.page()` itself sends, as opposed to
// http-log.ts's `ctx.request()` half. Subscribed once, at browser-context
// creation (browser-evidence.ts), the same place `observed`'s own `request`
// listener and page-events.ts's `console`/`weberror`/`requestfailed`
// listeners already are — a context-level subscription, not a page-level
// one, so a popup (`window.open`) is covered without a second listener
// (browser-evidence.ts's own header).
//
// Subscribes to `response`, not `request` (this task's spec, scope item 1):
// a request that never got a response at all (`requestfailed` — DNS,
// connection refused, aborted) is already `page_events.failed_requests`'
// own record (page-events.ts). Playwright fires exactly one of
// `response`/`requestfailed` for a given attempt, never both, so building
// http.jsonl entries only from `response` already keeps a network-level
// failure from ever being double-counted here — no separate dedup logic is
// needed for that case.
//
// Only `document`/`xhr`/`fetch` (`request.resourceType()`) are ever written
// to http.jsonl (this task's spec, scope item 2): a single page load can
// pull in dozens of images, a stylesheet, and a script bundle, and a file
// that tried to hold all of that would stop being something a reader opens.
// Everything else is tallied into `httpOmitted` instead of being silently
// dropped (CLAUDE.md "Nothing breaks silently") — the receipt's own
// `http_omitted` field (create-context.ts's `httpOmittedSnapshot`, wired
// into the receipt by cli/do.ts and run-scenario.ts) is that tally's own
// read side. `observed` (browser-evidence.ts's own `request` listener) is
// untouched by any of this — it keeps counting every request regardless of
// what this module goes on to do with it (http-omitted.ts's own header).
//
// `via: "page"` (http-log.ts's own `HttpLogEntry`) is what tells an entry
// this module wrote apart from one `ctx.request()` produced, on the same
// file, in whatever order the two happen to interleave in — this module
// never reorders or buffers, it only appends as each `response` event
// fires, same as http-log.ts's own `logCall` does for its own calls.
//
// Duration is measured the same way http-log.ts's own `logCall` measures
// its: wall time between this module's own `request` listener (the
// start-time map below) and the matching `response` — not Playwright's own
// `request.timing()`, whose `responseEnd` only populates once the whole
// body has downloaded (`requestfinished`, not `response`), and reads -1 for
// a response event fired before that.
//
// A write failure here (`appendHttpLogEntry` rejecting) is swallowed: an
// event handler has no caller to propagate a throw to, and losing one
// page-issued log line must not break the step the way browser-evidence.ts's
// own `finalize`/`endStepChunk` teardown already doesn't (docs/spec.md:
// measurement must never break execution).
//
// Each append is kicked off from inside a `response` handler, which has no
// caller of its own to await it — unlike http-log.ts's own `logCall`, whose
// `await appendHttpLogEntry(...)` sits on the same promise chain the step's
// own `await ctx.request()...` call is already waiting on. `pending` below
// (a `Set` of in-flight append promises) is what closes that gap: the
// handle's own `flush()` lets a caller wait for everything this
// subscription has started so far before it reads http.jsonl for the
// current step boundary — create-context.ts's `closeCurrentChunk` calls it
// at exactly that point, the same step-boundary choke point that already
// closes this step's own trace chunk before anything downstream reads from
// it.

/** What `subscribePageHttpLogging` hands back — see this file's own header
 * for why a `flush()` is needed at all. */
export interface PageHttpLogHandle {
  /** Resolves once every append this subscription has kicked off *so far*
   * has settled (written, or failed and been swallowed). Does not wait for
   * a `response` that has not fired yet — only for writes already in
   * flight when this is called, the same "measurement must never break
   * execution" limit the rest of this file's own writes already have. */
  flush(): Promise<void>;
}

/** Subscribes `context` so every `document`/`xhr`/`fetch` response its
 * page(s) receive is appended to http.jsonl (`logPath()`, redacted through
 * `secrets`, the same single call site `ctx.request()`'s own entries go
 * through), and every other response is tallied into `httpOmitted` instead.
 * Called once, at browser-context creation (browser-evidence.ts) — never
 * re-subscribed at a step boundary; `logPath` is a getter for the same
 * reason http-log.ts's own is, so it always reads whichever directory is
 * *current* when a response actually arrives. */
export function subscribePageHttpLogging(
  context: BrowserContext,
  logPath: () => string,
  secrets: SecretSet,
  httpOmitted: HttpOmittedCollector,
): PageHttpLogHandle {
  const startedAt = new Map<PlaywrightRequest, number>();
  const pending = new Set<Promise<void>>();

  context.on("request", (request) => {
    startedAt.set(request, performance.now());
  });

  context.on("requestfailed", (request) => {
    // Never produces a matching `response` event (this file's own header:
    // Playwright fires exactly one of the two per attempt) — deleted here
    // only so a page that issues many failing requests does not grow this
    // map without bound.
    startedAt.delete(request);
  });

  context.on("response", (response) => {
    const request = response.request();
    const start = startedAt.get(request);
    startedAt.delete(request);
    const resourceType = request.resourceType();

    if (resourceType !== "document" && resourceType !== "xhr" && resourceType !== "fetch") {
      httpOmitted.record(resourceType);
      return;
    }

    const durationMs = start === undefined ? 0 : Math.round(performance.now() - start);
    const write: Promise<void> = appendHttpLogEntry(
      logPath,
      {
        method: request.method(),
        url: request.url(),
        status: response.status(),
        duration_ms: durationMs,
        via: "page",
      },
      secrets,
    )
      .catch(() => {
        // See this file's own header: measurement must never break execution.
      })
      .finally(() => {
        pending.delete(write);
      });
    pending.add(write);
  });

  return {
    async flush(): Promise<void> {
      await Promise.all(pending);
    },
  };
}
