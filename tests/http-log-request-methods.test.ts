import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext, APIResponse } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpLogFailedCollector } from "../src/context/http-log-failed.js";
import { wrapRequestContextWithLogging } from "../src/context/http-log.js";

// Responsibility: pins the three wrapped methods (put/delete/head) and the
// `[Symbol.asyncDispose]` pass-through that tests/http-log.test.ts's own
// fetch()-only coverage never reaches, plus redaction on those same three
// methods: every step-facing verb this wrapper exposes must log and
// redact the same way, not just the ones an existing e2e fixture happens to
// call (tests/secrets.test.ts proves redaction end to end, but only through
// request.get()/request.post()).

function fakeResponse(status = 200, url = ""): APIResponse {
  return { status: () => status, url: () => url } as unknown as APIResponse;
}

interface FakeTarget {
  disposed: boolean;
}

function fakeRequestContext(): APIRequestContext & FakeTarget {
  const target = {
    disposed: false,
    get: async (target: string) => fakeResponse(200, target),
    post: async (target: string) => fakeResponse(200, target),
    put: async (target: string) => fakeResponse(200, target),
    patch: async (target: string) => fakeResponse(200, target),
    delete: async (target: string) => fakeResponse(200, target),
    head: async (target: string) => fakeResponse(204, target),
    fetch: async (target: string) => fakeResponse(200, target),
    dispose: async () => {
      target.disposed = true;
    },
    storageState: async () => ({ cookies: [], origins: [] }),
    tracing: {},
    [Symbol.asyncDispose]: async () => {
      target.disposed = true;
    },
  };
  return target as unknown as APIRequestContext & FakeTarget;
}

describe("wrapRequestContextWithLogging / put, delete, head, asyncDispose", () => {
  let evidenceDir: string;
  let logFile: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-http-log-methods-"));
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

  it("put(): logs method PUT, via: request", async () => {
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], createHttpLogFailedCollector());

    await wrapped.put("https://example.com/items/1", { data: { name: "x" } });

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("PUT");
    expect(lines[0]?.url).toBe("https://example.com/items/1");
    expect(lines[0]?.via).toBe("request");
  });

  it("delete(): logs method DELETE", async () => {
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], createHttpLogFailedCollector());

    await wrapped.delete("https://example.com/items/1");

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("DELETE");
    expect(lines[0]?.url).toBe("https://example.com/items/1");
  });

  it("head(): logs method HEAD, records the response's own status", async () => {
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, [], createHttpLogFailedCollector());

    await wrapped.head("https://example.com/items/1");

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("HEAD");
    expect(lines[0]?.status).toBe(204);
  });

  it("put()/delete()/head() redact a secret found in the url, the same as get()/post() already do", async () => {
    const secrets = [{ name: "API_TOKEN", value: "sekrit-value-123456" }];
    const wrapped = wrapRequestContextWithLogging(fakeRequestContext(), () => logFile, secrets, createHttpLogFailedCollector());

    await wrapped.put("https://example.com/items?token=sekrit-value-123456");
    await wrapped.delete("https://example.com/items/sekrit-value-123456");
    await wrapped.head("https://example.com/items?token=sekrit-value-123456");

    const logText = await readFile(logFile, "utf8");
    expect(logText).not.toContain("sekrit-value-123456");

    const lines = await readLines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.url as string).toContain("{{secret.API_TOKEN}}");
    }
  });

  it("[Symbol.asyncDispose](): passes straight through to the target's own, never logged", async () => {
    const target = fakeRequestContext();
    const wrapped = wrapRequestContextWithLogging(target, () => logFile, [], createHttpLogFailedCollector());

    await wrapped[Symbol.asyncDispose]();

    expect(target.disposed).toBe(true);
    // Nothing was ever logged: the append call this module's only write
    // path goes through never ran, so the file itself was never created.
    await expect(readFile(logFile, "utf8")).rejects.toThrow();
  });
});
