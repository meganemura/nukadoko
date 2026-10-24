import { appendFile } from "node:fs/promises";
import type { APIRequestContext, APIResponse } from "playwright";
import type { KeptText } from "../record/types.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { type ChannelHttpLine, channelRecorder, recordRequest, withoutChannelRecording } from "./channels.js";
import type { HttpLogFailedCollector } from "./http-log-failed.js";
import { bodyFields, type RawBody, rawBodyOf } from "./kept-text.js";

// Responsibility: wrap the APIRequestContext `ctx.request()` hands to a
// step's `run()` so every HTTP call it makes is measured and appended to
// http.jsonl, one JSON object per line: method, url, status, duration_ms,
// via, and the request and response bodies as text (kept-text.ts: capped
// at 16 KiB each, marked when cut). Headers are never written: they carry
// cookies and authorization, and the trace already holds what a reader
// needs of them. The line is redacted at the same point it is built,
// before it ever reaches disk, one of the three exits docs/spec.md
// "Environments and secrets" requires redaction at, alongside record.json
// and `do`'s stdout copy (both handled by cli/do.ts).
//
// The send runs outside the channel patches' recording (channels.ts):
// Playwright sends from this process through `node:http`, and this line
// already records the request, so it must not be recorded twice. Inside a
// step the line goes through the recorder of the step that made the call
// (`recordRequest`), the same as a `fetch` line: it is counted into that
// step's `observed.http`, written beside that step's record even when the
// response arrives after the next step began, and written with the
// no-response error when the step's flush ends first. Outside a step (a
// hook, a fixture) the line goes to the http.jsonl the boundary had when
// the call started.
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
// this module reads it when a call starts.

/** One http.jsonl line (docs/spec.md "Records"). `via` names which path
 * produced it. `"request"` is a call made through `ctx.request()`, or
 * through `page.request` / `context.request` (the same logging, via
 * `instrumentApiRequestContext`). `"page"` is one the page itself made
 * (page-http-log.ts). `"fetch"`, `"node:http"`, and `"node:https"` are
 * requests a step's own code sent, which the channel patches recorded
 * (channels.ts, observed.ts). Always present, on every entry either path
 * builds: a field only one of the two ever set would leave a reader
 * guessing "absent means page" instead of reading it. */
export interface HttpLogEntry {
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  via: "request" | "page" | "fetch" | "node:http" | "node:https";
  /** `via: "request"` only: the URL the step passed, when it differs from
   * `url` (a relative path, a `params` option, a redirect). */
  declared_url?: string;
  /** Why no response exists. Present exactly when `status` is 0. */
  error?: string;
  /** The `pageAs(name)` context whose page made the call (through the
   * page itself, or through `page.request`). Absent for the default
   * context and for `ctx.request()`. */
  as?: string;
  /** Not `"page"`: the body the request sent. Absent when it sent none. */
  request_body?: KeptText;
  /** Not `"page"`: the body of the response. Absent when no response
   * arrived or it had no body. */
  response_body?: KeptText;
  /** The request started after its step's record was written, so the
   * record does not count it (docs/spec.md "Records"). */
  after_step_end?: true;
}

/** The http.jsonl entry of one line a channel patch or a request context
 * recorded: its bodies kept as redacted text. */
export function httpLogEntryOf(line: ChannelHttpLine, secrets: SecretSet): HttpLogEntry {
  return {
    method: line.method,
    url: line.url,
    ...(line.declared_url !== undefined ? { declared_url: line.declared_url } : {}),
    status: line.status,
    duration_ms: line.duration_ms,
    via: line.via,
    ...(line.error !== undefined ? { error: line.error } : {}),
    ...(line.as !== undefined ? { as: line.as } : {}),
    ...bodyFields(line.request_body, line.response_body, secrets),
  };
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
  requestBody: () => Promise<RawBody | undefined>,
  as?: string,
): Promise<APIResponse> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const failed = (error: string, sent?: RawBody): ChannelHttpLine => ({
    method,
    url,
    status: 0,
    duration_ms: elapsed(),
    via: "request",
    error,
    ...(as !== undefined ? { as } : {}),
    ...(sent !== undefined ? { request_body: sent } : {}),
  });
  const rec = channelRecorder();
  const write = rec === undefined ? undefined : recordRequest(rec, (waitedMs) => failed(`no response within ${waitedMs} ms of the step's end`));
  const path = logPath();
  let response: APIResponse | undefined;
  let failure: unknown;
  try {
    response = await withoutChannelRecording(send);
    return response;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const sent = await requestBody().catch((): RawBody => ({ unread: "the request body could not be read" }));
    const received = response === undefined ? undefined : await responseBodyOf(response);
    const line: ChannelHttpLine = response
      ? {
          method,
          url: response.url(),
          ...(response.url() === url ? {} : { declared_url: url }),
          status: response.status(),
          duration_ms: elapsed(),
          via: "request",
          ...(as !== undefined ? { as } : {}),
          ...(sent !== undefined ? { request_body: sent } : {}),
          ...(received !== undefined ? { response_body: received } : {}),
        }
      : failed(firstLine(failure instanceof Error ? failure.message : String(failure)), sent);
    if (write !== undefined) {
      write(line);
    } else {
      try {
        await appendHttpLogEntry(() => path, httpLogEntryOf(line, secrets), secrets);
      } catch {
        httpLogFailed.record();
      }
    }
  }
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** The response's body, read from Playwright, which already holds all of
 * it. A disposed response cannot be read any more, and says so. */
async function responseBodyOf(response: APIResponse): Promise<RawBody | undefined> {
  try {
    const bytes = await withoutChannelRecording(() => response.body());
    return bytes.byteLength === 0 ? undefined : rawBodyOf(bytes);
  } catch {
    return { unread: "the response was disposed before it could be read" };
  }
}

type FetchOptions = Parameters<APIRequestContext["fetch"]>[1];

/** The body Playwright sends for `options`, encoded the way Playwright
 * encodes it: `data` as given, or as JSON when it is neither text nor
 * bytes, and an object `form` as URL-encoded text. A multipart body's
 * boundary exists only inside Playwright, so it is not read. */
function optionsBody(options: FetchOptions): RawBody | undefined {
  if (options === undefined) return undefined;
  const { data, form, multipart } = options as { data?: unknown; form?: unknown; multipart?: unknown };
  if (data !== undefined) {
    if (typeof data === "string") return rawBodyOf(Buffer.from(data, "utf8"));
    if (data instanceof Uint8Array) return rawBodyOf(data);
    return rawBodyOf(Buffer.from(JSON.stringify(data) ?? "", "utf8"));
  }
  if (form !== undefined) {
    if (form instanceof FormData) return { unread: "a multipart form, encoded by Playwright" };
    const pairs = Object.entries(form as Record<string, unknown>).map(([name, value]): [string, string] => [name, String(value)]);
    return rawBodyOf(Buffer.from(new URLSearchParams(pairs).toString(), "utf8"));
  }
  if (multipart !== undefined) return { unread: "a multipart body, encoded by Playwright" };
  return undefined;
}

/** The body of a call: from `options` when given, and otherwise from a
 * Playwright `Request` (`route.fetch()` passes the intercepted one). */
function bodyOf(target: Parameters<APIRequestContext["fetch"]>[0], options: FetchOptions): () => Promise<RawBody | undefined> {
  return async () => {
    const fromOptions = optionsBody(options);
    if (fromOptions !== undefined || typeof target === "string") return fromOptions;
    const bytes = target.postDataBuffer();
    return bytes === null || bytes.byteLength === 0 ? undefined : rawBodyOf(bytes);
  };
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
      logCall(logPath, "GET", url, secrets, httpLogFailed, () => target.get(url, options), bodyOf(url, options)),
    post: (url, options) =>
      logCall(logPath, "POST", url, secrets, httpLogFailed, () => target.post(url, options), bodyOf(url, options)),
    put: (url, options) =>
      logCall(logPath, "PUT", url, secrets, httpLogFailed, () => target.put(url, options), bodyOf(url, options)),
    patch: (url, options) =>
      logCall(logPath, "PATCH", url, secrets, httpLogFailed, () => target.patch(url, options), bodyOf(url, options)),
    delete: (url, options) =>
      logCall(logPath, "DELETE", url, secrets, httpLogFailed, () => target.delete(url, options), bodyOf(url, options)),
    head: (url, options) =>
      logCall(logPath, "HEAD", url, secrets, httpLogFailed, () => target.head(url, options), bodyOf(url, options)),
    fetch: (urlOrRequest, options) =>
      logCall(
        logPath,
        methodOf(urlOrRequest, options),
        urlOf(urlOrRequest),
        secrets,
        httpLogFailed,
        () => target.fetch(urlOrRequest, options),
        bodyOf(urlOrRequest, options),
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
      bodyOf(urlOrRequest, options),
      as,
    );
}
