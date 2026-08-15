import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext, APIResponse, Request } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapRequestContextWithLogging } from "../src/context/http-log.js";
import { createObservedCollector } from "../src/context/observed.js";

// Responsibility: pins urlOf/methodOf's fetch(string | Request) branch —
// the one branch in http-log.ts with no
// direct test before this file. Unit-level against
// wrapRequestContextWithLogging directly, with a fake APIRequestContext and
// a fake Request (`{ url: () => ..., method: () => ... }`), since a real
// Playwright `Request` can only come from an
// actual page/route, which create-context.test.ts already declined to pull
// in for the same reason.

function fakeResponse(status = 200): APIResponse {
  return { status: () => status } as unknown as APIResponse;
}

function fakeRequestContext(): APIRequestContext {
  return {
    fetch: async () => fakeResponse(),
  } as unknown as APIRequestContext;
}

function fakeRequest(url: string, method: string): Request {
  return {
    url: () => url,
    method: () => method,
  } as unknown as Request;
}

describe("wrapRequestContextWithLogging / fetch(url | Request)", () => {
  let evidenceDir: string;
  let logFile: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-http-log-"));
    logFile = path.join(evidenceDir, "http.jsonl");
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  async function readLines(): Promise<Record<string, unknown>[]> {
    return (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("fetch(url string): method defaults to GET, url is the string as given", async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);

    await wrapped.fetch("https://example.com/items");

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("GET");
    expect(lines[0]?.url).toBe("https://example.com/items");
    expect(observed.snapshot()).toEqual({ http_reads: 1, http_writes: 0 });
  });

  // Every
  // ctx.request() entry carries `via: "request"` explicitly, the same as
  // page-http-log.ts's own entries carry `via: "page"` — never left absent
  // for a reader to infer from its shape alone (this file's own module
  // header).
  it('every entry carries via: "request", explicitly', async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);

    await wrapped.fetch("https://example.com/items");

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.via).toBe("request");
  });

  it('fetch(url string, { method: "post" }): method is upper-cased to POST', async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);

    await wrapped.fetch("https://example.com/items", { method: "post" });

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("POST");
    expect(lines[0]?.url).toBe("https://example.com/items");
    expect(observed.snapshot()).toEqual({ http_reads: 0, http_writes: 1 });
  });

  it("fetch(Request) with no options: method comes from the Request itself, not GET", async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);
    const request = fakeRequest("https://example.com/items", "POST");

    await wrapped.fetch(request);

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    // This is the branch with no prior direct test: if methodOf ever fell
    // back to "GET" for a Request target (instead of asking the Request its
    // own method), this line and the tally below would both silently lie.
    expect(lines[0]?.method).toBe("POST");
    expect(lines[0]?.url).toBe("https://example.com/items");
    expect(observed.snapshot()).toEqual({ http_reads: 0, http_writes: 1 });
  });

  it('fetch(Request, { method: "PUT" }): options.method wins over the Request\'s own method', async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);
    const request = fakeRequest("https://example.com/items", "POST");

    await wrapped.fetch(request, { method: "PUT" });

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("PUT");
    expect(lines[0]?.url).toBe("https://example.com/items");
    expect(observed.snapshot()).toEqual({ http_reads: 0, http_writes: 1 });
  });

  it("fetch(Request): url is taken from request.url()", async () => {
    const observed = createObservedCollector();
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], observed);
    const request = fakeRequest("https://example.com/from-request", "GET");

    await wrapped.fetch(request);

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.url).toBe("https://example.com/from-request");
    expect(lines[0]?.method).toBe("GET");
    expect(observed.snapshot()).toEqual({ http_reads: 1, http_writes: 0 });
  });
});
