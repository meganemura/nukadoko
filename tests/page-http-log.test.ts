import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Request, Response } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpLogFailedCollector } from "../src/context/http-log-failed.js";
import { createHttpOmittedCollector } from "../src/context/http-omitted.js";
import { subscribePageHttpLogging } from "../src/context/page-http-log.js";

// Responsibility: a page request's http.jsonl line belongs to the step that
// sent it. `observed` counts the request when it starts
// (browser-evidence.ts). The log path has to be the directory current at
// that same moment, including when the response arrives after the next
// step boundary has moved the getter. A real browser is not required: the
// subscription only listens, and the bug is which path it reads.

function fakeContext(): BrowserContext & EventEmitter {
  return new EventEmitter() as BrowserContext & EventEmitter;
}

function fakePageRequest(url: string, method: string, resourceType: string): Request {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
  } as unknown as Request;
}

function fakeResponse(request: Request, status: number): Response {
  return {
    request: () => request,
    status: () => status,
  } as unknown as Response;
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (text.trim() === "") {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("subscribePageHttpLogging", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends a page response to the log path current when the request started", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nukadoko-page-http-log-"));
    const stepA = path.join(root, "step-a");
    const stepB = path.join(root, "step-b");
    await mkdir(stepA);
    await mkdir(stepB);
    const stepALog = path.join(stepA, "http.jsonl");
    const stepBLog = path.join(stepB, "http.jsonl");

    // Step A sends the POST and returns. The boundary then points the
    // getter at step B, which sends its own GET. Both responses arrive
    // during step B. The POST still belongs on step A, beside the write
    // `observed` already counted there.
    let current = stepALog;
    const context = fakeContext();
    const handle = subscribePageHttpLogging(
      context,
      () => current,
      [],
      createHttpOmittedCollector(),
      createHttpLogFailedCollector(),
    );
    const post = fakePageRequest("http://127.0.0.1/save", "POST", "fetch");
    context.emit("request", post);
    current = stepBLog;
    const get = fakePageRequest("http://127.0.0.1/next", "GET", "document");
    context.emit("request", get);
    context.emit("response", fakeResponse(get, 200));
    context.emit("response", fakeResponse(post, 201));
    await handle.flush();

    const stepALines = await readLines(stepALog);
    const stepBLines = await readLines(stepBLog);
    expect(stepALines).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "http://127.0.0.1/save",
        status: 201,
        via: "page",
      }),
    ]);
    expect(stepBLines).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://127.0.0.1/next",
        status: 200,
        via: "page",
      }),
    ]);
    expect(stepALines[0]?.duration_ms).toEqual(expect.any(Number));
    expect(stepBLines[0]?.duration_ms).toEqual(expect.any(Number));
  });

  // A failed append used to vanish: `observed` counted the request while
  // neither http.jsonl nor any other field said a line was missing.
  it("tallies every append that fails and still writes the others", () =>
    hegel.testAsync(async (tc) => {
      const writable = tc.draw(gs.arrays(gs.booleans(), { minSize: 0, maxSize: 8 }));
      root = await mkdtemp(path.join(os.tmpdir(), "nukadoko-page-http-log-"));
      const good = path.join(root, "good");
      await mkdir(good);
      const paths = writable.map((ok) => path.join(ok ? good : path.join(root, "missing"), "http.jsonl"));
      let next = 0;
      const failed = createHttpLogFailedCollector();
      const context = fakeContext();
      const handle = subscribePageHttpLogging(
        context,
        () => paths[next] as string,
        [],
        createHttpOmittedCollector(),
        failed,
      );
      for (let index = 0; index < paths.length; index += 1) {
        next = index;
        const request = fakePageRequest(`http://127.0.0.1/${index}`, "GET", "fetch");
        context.emit("request", request);
        context.emit("response", fakeResponse(request, 200));
      }
      await handle.flush();

      const lost = writable.filter((ok) => !ok).length;
      expect(failed.snapshot()).toBe(lost === 0 ? undefined : lost);
      expect(await readLines(path.join(good, "http.jsonl"))).toHaveLength(writable.length - lost);
    }));
});
