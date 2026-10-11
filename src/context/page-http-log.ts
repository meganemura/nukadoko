import type { BrowserContext, Request as PlaywrightRequest } from "playwright";
import type { SecretSet } from "../secrets/types.js";
import { appendHttpLogEntry } from "./http-log.js";
import type { HttpOmittedCollector } from "./http-omitted.js";

// Responsibility: the page-origin half of http.jsonl — everything a step's
// `ctx.page()` itself sends, as opposed to
// http-log.ts's `ctx.request()` half. Subscribed once, at browser-context
// creation (browser-evidence.ts), the same place `observed`'s own `request`
// listener and page-events.ts's `console`/`weberror`/`requestfailed`
// listeners already are — a context-level subscription, not a page-level
// one, so a popup (`window.open`) is covered without a second listener
// (browser-evidence.ts's own header).
//
// Subscribes to `response`, not `request`:
// a request that never got a response at all (`requestfailed` — DNS,
// connection refused, aborted) is already `page_events.failed_requests`'
// own record (page-events.ts). Playwright fires exactly one of
// `response`/`requestfailed` for a given attempt, never both, so building
// http.jsonl entries only from `response` already keeps a network-level
// failure from ever being double-counted here — no separate dedup logic is
// needed for that case.
//
// Only `document`/`xhr`/`fetch` (`request.resourceType()`) are ever written
// to http.jsonl: a single page load can
// pull in dozens of images, a stylesheet, and a script bundle, and a file
// that tried to hold all of that would stop being something a reader opens.
// Everything else is tallied into `httpOmitted` instead of being silently
// dropped. The step record's own
// `http_omitted` field (create-context.ts's `httpOmittedSnapshot`, wired
// into the step record by cli/do.ts and run-scenario.ts) is that tally's own
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
// map below) and the matching `response` — not Playwright's own
// `request.timing()`, whose `responseEnd` only populates once the whole
// body has downloaded (`requestfinished`, not `response`), and reads -1 for
// a response event fired before that.
//
// That same map stores the log path resolved on the request event. `logPath`
// stays a getter, so a request that starts after `beginStep` moves the
// directory lands in the new step. Reading the getter again when the
// response arrives would write the line into whichever step is current
// then. A click that returns before its POST finishes would leave the POST
// on the next step, whose `observed` says it wrote nothing, while the step
// that sent it already counted the write (browser-evidence.ts records
// `observed` on `request`, not on `response`).
//
// A write failure here (`appendHttpLogEntry` rejecting) is swallowed: an
// event handler has no caller to propagate a throw to, and losing one
// page-issued log line must not break the step the way browser-evidence.ts's
// own `finalize`/`endStepChunk` teardown already doesn't. Measurement must
// not break execution.
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
 * page(s) receive is appended to http.jsonl (redacted through `secrets`,
 * the same single call site `ctx.request()`'s own entries go through), and
 * every other response is tallied into `httpOmitted` instead. Called once,
 * at browser-context creation (browser-evidence.ts), never re-subscribed
 * at a step boundary. `logPath` stays a getter so a request that starts
 * after the directory moves lands in the new step. The path is read when
 * the request starts (see this file's own header): the response is
 * appended to that path, not to wherever the getter points when the
 * response arrives. */
export function subscribePageHttpLogging(
  context: BrowserContext,
  logPath: () => string,
  secrets: SecretSet,
  httpOmitted: HttpOmittedCollector,
): PageHttpLogHandle {
  // `at` is the duration origin. `logPath` is that step's http.jsonl,
  // resolved now so a later step boundary cannot move the line.
  const started = new Map<PlaywrightRequest, { at: number; logPath: string }>();
  const pending = new Set<Promise<void>>();

  context.on("request", (request) => {
    started.set(request, { at: performance.now(), logPath: logPath() });
  });

  context.on("requestfailed", (request) => {
    // Never produces a matching `response` event (this file's own header:
    // Playwright fires exactly one of the two per attempt) — deleted here
    // only so a page that issues many failing requests does not grow this
    // map without bound.
    started.delete(request);
  });

  context.on("response", (response) => {
    const request = response.request();
    const start = started.get(request);
    started.delete(request);
    const resourceType = request.resourceType();

    if (resourceType !== "document" && resourceType !== "xhr" && resourceType !== "fetch") {
      httpOmitted.record(resourceType);
      return;
    }

    // A response with no matching `request` event has no stored path.
    // Fall back to the getter as it stands now, the same duration-0
    // fallback this branch already uses when the start time is missing.
    const entryPath = start === undefined ? logPath() : start.logPath;
    const durationMs = start === undefined ? 0 : Math.round(performance.now() - start.at);
    const write: Promise<void> = appendHttpLogEntry(
      () => entryPath,
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
