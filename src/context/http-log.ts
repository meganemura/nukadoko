import { appendFile } from "node:fs/promises";
import type { APIRequestContext, APIResponse } from "playwright";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import type { HttpLogFailedCollector } from "./http-log-failed.js";

// Responsibility: wrap the APIRequestContext `ctx.request()` hands to a
// step's `run()` so every HTTP call it makes is measured and appended to
// http.jsonl — one JSON object per line, method/url/status/duration_ms/via
// only (never request/response bodies: docs/spec.md "Records" says
// evidence is collected by the harness, not asserted by the step). `url` is
// the one field that can carry a secret (e.g. a token in a query string): it
// is redacted at the same point the line is built, before it ever reaches
// disk — one of the three exits docs/spec.md "Environments and secrets" requires redaction
// at, alongside record.json and `do`'s stdout copy (both handled by
// cli/do.ts).
//
// `via` is added now: a page's own document/xhr/fetch traffic now lands on
// the same http.jsonl, appended by page-http-log.ts rather than this
// module, and `via` is what tells the two apart. `"request"` is every
// entry this module builds, whether the step called `ctx.request()` or
// the APIRequestContext on `page.request` / `context.request`
// (`instrumentApiRequestContext` below). `"page"` is page-http-log.ts's
// own. Those two APIRequestContext objects are the same one Playwright
// hangs on the browser context, and they do not emit the context
// `request` event page-http-log.ts reads,
// so leaving them to that listener records nothing.
// `appendHttpLogEntry` below is exported for that module to call: one
// redact-and-append call site for both paths, so neither can drift into
// redacting differently than the other.
//
// A call is logged whatever its outcome, from a `finally`: a call that
// throws (a refused connection, `failOnStatusCode` on a 4xx/5xx) still
// happened. With no response the line
// carries `status: 0` and an `error` (the first line of the message only:
// Playwright appends a call log that can hold request headers). With a
// response, `url` is `response.url()`, the absolute URL after params and
// redirects, the same shape a page entry's `url` has; `declared_url` keeps
// what the step passed, and only when it differs.
//
// An append that fails here does not throw into the step, the same policy
// page-http-log.ts has: it is counted into `httpLogFailed` (the step
// record's `http_log_failed`). A throw from the `finally` would also replace
// the call's own error.
//
// A manual per-method wrapper, not a Proxy: Playwright's client classes are
// plain JS objects/prototypes as far as this package can see, but a Proxy
// still changes `this` to the proxy itself for any method invoked through
// it. Explicit delegation keeps `this` bound to the real context for every
// call, logged or not, with no reliance on how Playwright implements state
// internally.
//
// `logPath` is a getter, not a fixed string, so `nuka run`'s scenario-shared
// context (create-context.ts) can redirect where the *next* logged call
// lands without recreating the wrapped context itself: a pickle's steps
// share one ctx (and therefore one memoized request context, cookies
// intact), but each step's http.jsonl must land in that step's own step
// record
// dir — the executor advances the getter's target at each step boundary;
// this module just reads it at call time.

/** One http.jsonl line (docs/spec.md "Records"). `via` names which path
 * produced it. `"request"` is a call made through `ctx.request()`, or
 * through `page.request` / `context.request` (the same logging, via
 * `instrumentApiRequestContext`). `"page"` is one the page itself made
 * (page-http-log.ts). Always present, on every entry either path
 * builds: a field only one of the two ever set would leave a reader
 * guessing "absent means page" instead of reading it. */
export interface HttpLogEntry {
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  via: "request" | "page";
  /** `via: "request"` only: the URL the step passed, when it differs from
   * `url` (a relative path, a `params` option, a redirect). */
  declared_url?: string;
  /** `via: "request"` only: why the call threw. Present exactly when no
   * response exists, and then `status` is 0. */
  error?: string;
  /** The `pageAs(name)` context whose page made the call (through the
   * page itself, or through `page.request`). Absent for the default
   * context and for `ctx.request()`. */
  as?: string;
}

/** Redacts `entry` and appends it to whatever `logPath()` currently points
 * at, one JSON object per line — the single redact-and-append call site
 * both this module's own `logCall` and page-http-log.ts's page-origin path
 * go through (this file's own header). */
export async function appendHttpLogEntry(
  logPath: () => string,
  entry: HttpLogEntry,
  secrets: SecretSet,
): Promise<void> {
  const redacted = redact(entry, secrets);
  await appendFile(logPath(), `${JSON.stringify(redacted)}\n`);
}

async function logCall(
  logPath: () => string,
  method: string,
  url: string,
  secrets: SecretSet,
  httpLogFailed: HttpLogFailedCollector,
  send: () => Promise<APIResponse>,
  as?: string,
): Promise<APIResponse> {
  const startedAt = performance.now();
  let response: APIResponse | undefined;
  let failure: unknown;
  try {
    response = await send();
    return response;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    const entry: HttpLogEntry = response
      ? {
          method,
          url: response.url(),
          ...(response.url() === url ? {} : { declared_url: url }),
          status: response.status(),
          duration_ms: durationMs,
          via: "request",
          ...(as !== undefined ? { as } : {}),
        }
      : {
          method,
          url,
          status: 0,
          duration_ms: durationMs,
          via: "request",
          error: firstLine(failure instanceof Error ? failure.message : String(failure)),
          ...(as !== undefined ? { as } : {}),
        };
    try {
      await appendHttpLogEntry(logPath, entry, secrets);
    } catch {
      httpLogFailed.record();
    }
  }
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

function urlOf(target: Parameters<APIRequestContext["fetch"]>[0]): string {
  return typeof target === "string" ? target : target.url();
}

// `options?.method` wins when given; otherwise a Request object (unlike a
// bare URL string) already knows its own method, so ask it rather than
// defaulting to GET and misreporting e.g. a POST Request passed with no
// `options` at all.
function methodOf(
  target: Parameters<APIRequestContext["fetch"]>[0],
  options?: Parameters<APIRequestContext["fetch"]>[1],
): string {
  const method = options?.method ?? (typeof target === "string" ? undefined : target.method());
  return (method ?? "GET").toUpperCase();
}

/** Wraps `target` so get/post/put/patch/delete/head/fetch are logged to
 * whatever `logPath()` currently returns, with `secrets` redacted from each
 * logged line; `dispose`/`storageState` pass
 * straight through unlogged. */
export function wrapRequestContextWithLogging(
  target: APIRequestContext,
  logPath: () => string,
  secrets: SecretSet,
  httpLogFailed: HttpLogFailedCollector,
): APIRequestContext {
  return {
    get: (url, options) =>
      logCall(logPath, "GET", url, secrets, httpLogFailed, () => target.get(url, options)),
    post: (url, options) =>
      logCall(logPath, "POST", url, secrets, httpLogFailed, () => target.post(url, options)),
    put: (url, options) =>
      logCall(logPath, "PUT", url, secrets, httpLogFailed, () => target.put(url, options)),
    patch: (url, options) =>
      logCall(logPath, "PATCH", url, secrets, httpLogFailed, () => target.patch(url, options)),
    delete: (url, options) =>
      logCall(logPath, "DELETE", url, secrets, httpLogFailed, () => target.delete(url, options)),
    head: (url, options) =>
      logCall(logPath, "HEAD", url, secrets, httpLogFailed, () => target.head(url, options)),
    fetch: (urlOrRequest, options) =>
      logCall(
        logPath,
        methodOf(urlOrRequest, options),
        urlOf(urlOrRequest),
        secrets,
        httpLogFailed,
        () => target.fetch(urlOrRequest, options),
      ),
    dispose: (options) => target.dispose(options),
    storageState: (options) => target.storageState(options),
    // Pass-through, not logged: `tracing` isn't an HTTP call, and
    // `[Symbol.asyncDispose]` is `dispose()`'s `using`-syntax alias.
    tracing: target.tracing,
    [Symbol.asyncDispose]: () => target[Symbol.asyncDispose](),
  };
}

// `page.request` and `context.request` are one APIRequestContext, and
// Playwright copies that reference onto each Page. Replacing the object
// with `wrapRequestContextWithLogging`'s stand-in would drop
// `_innerFetch`, which `route.fetch()` calls on `context.request`. The
// public verbs (`get`/`post`/`put`/`patch`/`delete`/`head`) all delegate
// to `this.fetch`, and `fetch` does not call itself, so replacing `fetch`
// once logs every verb once and leaves the real object in place.
const instrumentedApiRequests = new WeakSet<APIRequestContext>();

/** Logs `target`'s HTTP verbs into http.jsonl, in place,
 * for as long as `target` lives (the launched browser closes it).
 * Idempotent: a second call on the same object does nothing, so
 * one POST cannot be logged twice when both `page.request` and
 * `context.request` are passed, or when a later page copies the same
 * reference. */
export function instrumentApiRequestContext(
  target: APIRequestContext,
  logPath: () => string,
  secrets: SecretSet,
  httpLogFailed: HttpLogFailedCollector,
  as?: string,
): void {
  if (instrumentedApiRequests.has(target)) {
    return;
  }
  instrumentedApiRequests.add(target);
  const originalFetch = target.fetch.bind(target);
  target.fetch = (urlOrRequest, options) =>
    logCall(
      logPath,
      methodOf(urlOrRequest, options),
      urlOf(urlOrRequest),
      secrets,
      httpLogFailed,
      () => originalFetch(urlOrRequest, options),
      as,
    );
}
