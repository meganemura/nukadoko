import { appendFile } from "node:fs/promises";
import type { APIRequestContext, APIResponse } from "playwright";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";

// Responsibility: wrap the APIRequestContext `ctx.request()` hands to a
// step's `run()` so every HTTP call it makes is measured and appended to
// http.jsonl — one JSON object per line, method/url/status/duration_ms only
// (never request/response bodies: docs/spec.md "Receipts" says evidence is
// collected by the harness, not asserted by the step). `url` is the one
// field that can carry a secret (e.g. a token in a query string, per the
// step in this task's spec's integration test): it is redacted at the same
// point the line is built, before it ever reaches disk — one of the three
// exits docs/spec.md "Secrets" requires redaction at, alongside receipt.json
// and `do`'s stdout copy (both handled by cli/do.ts).
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
// intact), but each step's http.jsonl must land in that step's own receipt
// dir (this task's spec, decision 5) — the executor advances the getter's
// target at each step boundary; this module just reads it at call time.

async function logCall(
  logPath: () => string,
  method: string,
  url: string,
  secrets: SecretSet,
  send: () => Promise<APIResponse>,
): Promise<APIResponse> {
  const startedAt = performance.now();
  const response = await send();
  const durationMs = Math.round(performance.now() - startedAt);
  const entry = redact(
    { method, url, status: response.status(), duration_ms: durationMs },
    secrets,
  );
  await appendFile(logPath(), `${JSON.stringify(entry)}\n`);
  return response;
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
 * logged line; `dispose`/`storageState` pass straight through unlogged. */
export function wrapRequestContextWithLogging(
  target: APIRequestContext,
  logPath: () => string,
  secrets: SecretSet,
): APIRequestContext {
  return {
    get: (url, options) =>
      logCall(logPath, "GET", url, secrets, () => target.get(url, options)),
    post: (url, options) =>
      logCall(logPath, "POST", url, secrets, () => target.post(url, options)),
    put: (url, options) =>
      logCall(logPath, "PUT", url, secrets, () => target.put(url, options)),
    patch: (url, options) =>
      logCall(logPath, "PATCH", url, secrets, () => target.patch(url, options)),
    delete: (url, options) =>
      logCall(logPath, "DELETE", url, secrets, () => target.delete(url, options)),
    head: (url, options) =>
      logCall(logPath, "HEAD", url, secrets, () => target.head(url, options)),
    fetch: (urlOrRequest, options) =>
      logCall(logPath, methodOf(urlOrRequest, options), urlOf(urlOrRequest), secrets, () =>
        target.fetch(urlOrRequest, options),
      ),
    dispose: (options) => target.dispose(options),
    storageState: (options) => target.storageState(options),
    // Pass-through, not logged: `tracing` isn't an HTTP call, and
    // `[Symbol.asyncDispose]` is `dispose()`'s `using`-syntax alias.
    tracing: target.tracing,
    [Symbol.asyncDispose]: () => target[Symbol.asyncDispose](),
  };
}
