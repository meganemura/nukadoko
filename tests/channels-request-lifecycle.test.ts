import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector, finalizeOpenRequests, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: when a request's line is written, and what it says about
// how the request ended (src/context/channels.ts, src/context/observed.ts).
// A response with no body by protocol is complete at its status, and one
// whose body the step never started reading is written at the flush
// without a wait, saying so. A body that failed (an abort, a destroy) is
// an error, never incomplete: incomplete is only nukadoko's own stop. The
// no-response error states how long the request really had. A request
// still open when the run ends gets its line then.

let server: http.Server;
let base: string;
// Requests to /slow are held here until a test lets them go.
const held: http.ServerResponse[] = [];

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/slow") {
      held.push(res);
      return;
    }
    if (req.url === "/204") return void res.writeHead(204).end();
    if (req.url === "/304") return void res.writeHead(304).end();
    if (req.url === "/zero") return void res.writeHead(200, { "content-length": "0" }).end();
    if (req.url === "/later") return void setTimeout(() => res.end("hello"), 100);
    if (req.url === "/abort") {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      return void setTimeout(() => res.socket?.destroy(), 50);
    }
    if (req.url === "/stream") {
      res.writeHead(200);
      res.write("first");
      return void held.push(res);
    }
    res.end("hello");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let dir: string;
let observed: ObservedCollector;

beforeEach(async () => {
  dir = await createEmptyTempDir();
  observed = createObservedCollector({ outputDir: () => path.join(dir, "record"), unwatchedDirs: [path.join(dir, "state")] });
});

afterEach(async () => {
  for (const res of held.splice(0)) res.end();
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

function httpLines(): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(dir, "record", "http.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const { duration_ms: _ms, ...rest } = JSON.parse(line) as Record<string, unknown>;
        return rest;
      });
  } catch {
    return [];
  }
}

/** Sends a request and resolves with its response, which nobody reads. */
function respond(url: string, method = "GET"): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.request(url, { method }, resolve).on("error", reject).end();
  });
}

async function timedFlush(): Promise<number> {
  const startedAt = performance.now();
  // A deadline far past what the test waits, so a flush that waited for
  // a body nobody reads shows as the deadline.
  await observed.flush(10_000);
  return performance.now() - startedAt;
}

describe("a node:http response the step does not read", () => {
  it("is complete at its status when the protocol gives it no body, and the flush does not wait", async () => {
    const responses = await inStep(() =>
      Promise.all([respond(`${base}/x`, "HEAD"), respond(`${base}/204`), respond(`${base}/304`), respond(`${base}/zero`)]),
    );
    expect(await timedFlush()).toBeLessThan(5_000);
    expect(httpLines()).toEqual(
      expect.arrayContaining([
        { method: "HEAD", url: `${base}/x`, status: 200, via: "node:http" },
        { method: "GET", url: `${base}/204`, status: 204, via: "node:http" },
        { method: "GET", url: `${base}/304`, status: 304, via: "node:http" },
        { method: "GET", url: `${base}/zero`, status: 200, via: "node:http" },
      ]),
    );
    expect(httpLines()).toHaveLength(4);
    for (const res of responses) res.destroy();
  });

  it("is written at the flush without a wait, saying the step did not read the body", async () => {
    const response = await inStep(() => respond(`${base}/x`));
    expect(await timedFlush()).toBeLessThan(5_000);
    expect(httpLines()).toEqual([{ method: "GET", url: `${base}/x`, status: 200, via: "node:http", response_body: { unread: "the step did not read the body" } }]);
    response.destroy();
  });

  it("is written without a wait when it arrives while the flush waits", async () => {
    let response: http.IncomingMessage | undefined;
    await inStep(async () => {
      // Not awaited: the response arrives 100 ms into the flush.
      void respond(`${base}/later`).then((res) => (response = res));
    });
    expect(await timedFlush()).toBeLessThan(5_000);
    expect(httpLines()).toEqual([{ method: "GET", url: `${base}/later`, status: 200, via: "node:http", response_body: { unread: "the step did not read the body" } }]);
    response?.destroy();
  });
});

describe("a body that ends before it is whole", () => {
  it("has the error, not incomplete, when the server aborts it, from node:http and from fetch alike", async () => {
    await inStep(async () => {
      await new Promise<void>((resolve) => {
        http.get(`${base}/abort`, (res) => {
          res.on("data", () => undefined);
          res.on("error", () => undefined);
          res.on("close", resolve);
        });
      });
      await fetch(`${base}/abort`)
        .then((res) => res.text())
        .catch(() => undefined);
    });
    await observed.flush();
    const lines = httpLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const body = line.response_body as Record<string, unknown>;
      expect(body).toMatchObject({ text: "partial", truncated: true, bytes_read: 7, error: expect.any(String) });
      expect(body).not.toHaveProperty("incomplete");
    }
  });

  it("has the error when the step destroys the response", async () => {
    await inStep(
      () =>
        new Promise<void>((resolve) => {
          http.get(`${base}/stream`, (res) => {
            res.once("data", () => res.destroy());
            res.on("close", resolve);
          });
        }),
    );
    await observed.flush();
    expect(httpLines()).toEqual([
      {
        method: "GET",
        url: `${base}/stream`,
        status: 200,
        via: "node:http",
        response_body: { text: "first", truncated: true, bytes_read: 5, error: "the response closed before its end" },
      },
    ]);
  });

  it("is incomplete only when nukadoko stopped waiting for it", async () => {
    await inStep(async () => {
      http.get(`${base}/stream`, (res) => res.on("data", () => undefined));
      while (held.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await observed.flush(100);
    expect(httpLines()).toEqual([
      { method: "GET", url: `${base}/stream`, status: 200, via: "node:http", response_body: { text: "first", truncated: true, bytes_read: 5, incomplete: true } },
    ]);
  });
});

describe("a request with no response", () => {
  it("says how long it had when the flush stopped waiting, which is less for one sent during the flush", async () => {
    await inStep(async () => {
      void fetch(`${base}/slow`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      setTimeout(() => void fetch(`${base}/slow`).catch(() => undefined), 0);
    });
    await observed.flush(300);
    const errors = httpLines().map((line) => String(line.error));
    expect(errors).toHaveLength(2);
    const ms = errors.map((error) => {
      const match = /^no response before the step ended, (\d+) ms after it was sent$/.exec(error);
      expect(match, error).not.toBeNull();
      return Number(match![1]);
    });
    const [early, late] = ms[0]! > ms[1]! ? [ms[0]!, ms[1]!] : [ms[1]!, ms[0]!];
    expect(early).toBeGreaterThanOrEqual(600);
    expect(late).toBeLessThanOrEqual(early - 200);
  });

  it("gets its line when the run ends, when it started after its step's record was written", async () => {
    const run = observed.openRun([]);
    let leave: () => void = () => undefined;
    const left = new Promise<void>((resolve) => (leave = resolve));
    void withProcessRecording(run, async () => {
      await left;
      void fetch(`${base}/slow`).catch(() => undefined);
    });
    await observed.flush();
    observed.snapshot();
    observed.close();
    leave();
    while (held.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(observed.afterStepEnd()).toEqual({ requests: 1, processes: 0 });
    expect(httpLines()).toEqual([]);
    finalizeOpenRequests();
    expect(httpLines()).toEqual([
      {
        method: "GET",
        url: `${base}/slow`,
        status: 0,
        via: "fetch",
        error: expect.stringMatching(/^no response before the run ended, \d+ ms after it was sent$/),
        after_step_end: true,
      },
    ]);
  });
});
