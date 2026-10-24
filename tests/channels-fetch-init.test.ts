import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a `fetch` in a step sends exactly what the caller passed
// (src/context/channels.ts, `requestBodyOf`). The second argument is a
// RequestInit dictionary, and `fetch` reads each member with a property
// get, so a Request (a forwarding proxy passes the incoming one) or a
// class instance whose members are getters on its prototype is a valid
// one. A copy of it keeps only own fields and drops those members, so the
// request sent would differ from the caller's, or `fetch` would refuse it.
// The record reads a body only where that changes nothing the caller
// passed, and names the rest unread.

let server: http.Server;
let base: string;

beforeAll(async () => {
  installChannelPatches();
  // Answers with what it received. A multipart boundary is random for each
  // encoding, so it is replaced, and the same form sent twice reads the
  // same.
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const boundary = /boundary=(\S+)/.exec(req.headers["content-type"] ?? "")?.[1];
      const body = Buffer.concat(chunks).toString("utf8");
      res.end(`${req.method} ${req.url} ${req.headers["x-from"] ?? "-"} ${boundary === undefined ? body : body.replaceAll(boundary, "BOUNDARY")}`);
    });
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

/** What the server answered to `fetch(...args())`, or the error `fetch`
 * gave. `args` builds new arguments for each call, since a body can be
 * sent once. */
async function answer(args: () => Parameters<typeof fetch>): Promise<string> {
  try {
    return await (await fetch(...args())).text();
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
}

/** The answer outside a step and inside one, and the step's line. */
async function sentBoth(args: () => Parameters<typeof fetch>): Promise<{ outside: string; inside: string; line: Record<string, unknown> | undefined }> {
  const outside = await answer(args);
  const inside = await inStep(() => answer(args));
  await observed.flush();
  const lines = httpLines();
  expect(lines).toHaveLength(1);
  return { outside, inside, line: lines[0] };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A RequestInit whose members are getters on its prototype, with no own
 * field at all. */
class StreamOptions {
  readonly #body = streamOf("streamed");
  get method(): string {
    return "PUT";
  }
  get headers(): Record<string, string> {
    return { "x-from": "class" };
  }
  get body(): ReadableStream<Uint8Array> {
    return this.#body;
  }
  get duplex(): "half" {
    return "half";
  }
}

class TextOptions {
  get method(): string {
    return "PATCH";
  }
  get body(): string {
    return "from a getter";
  }
}

describe("fetch(input, init) in a step", () => {
  it("sends a Request given as init exactly as outside a step, and records its body", async () => {
    const { outside, inside, line } = await sentBoth(() => [
      `${base}/out`,
      new Request(`${base}/in`, { method: "POST", body: "payload", headers: { "x-from": "request" } }),
    ]);
    expect(outside).toBe("POST /out request payload");
    expect(inside).toBe(outside);
    expect(line).toEqual({
      method: "POST",
      url: `${base}/out`,
      status: 200,
      via: "fetch",
      request_body: { text: "payload", bytes: 7 },
      response_body: { text: outside, bytes: outside.length },
    });
  });

  it("sends a class instance whose members are getters exactly as outside a step", async () => {
    const streamed = await sentBoth(() => [`${base}/class`, new StreamOptions() as RequestInit]);
    expect(streamed.outside).toBe("PUT /class class streamed");
    expect(streamed.inside).toBe(streamed.outside);
    expect(streamed.line).toMatchObject({ method: "PUT", status: 200, request_body: { unread: expect.any(String) } });

    observed = createObservedCollector({ outputDir: () => path.join(dir, "record-text"), unwatchedDirs: [] });
    const outside = await answer(() => [`${base}/class`, new TextOptions() as RequestInit]);
    const inside = await inStep(() => answer(() => [`${base}/class`, new TextOptions() as RequestInit]));
    await observed.flush();
    expect(outside).toBe("PATCH /class - from a getter");
    expect(inside).toBe(outside);
    const lines = readFileSync(path.join(dir, "record-text", "http.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ method: "PATCH", request_body: { text: "from a getter", bytes: 13 } });
  });

  it("sends a plain object exactly as outside a step, and records a body it can read without taking it", async () => {
    const { outside, inside, line } = await sentBoth(() => [`${base}/plain`, { method: "POST", body: "plain", headers: { "x-from": "object" } }]);
    expect(outside).toBe("POST /plain object plain");
    expect(inside).toBe(outside);
    expect(line).toMatchObject({ method: "POST", request_body: { text: "plain", bytes: 5 } });
  });

  it("sends a plain object's stream body untouched, and names it unread", async () => {
    const { outside, inside, line } = await sentBoth(() => [`${base}/stream`, { method: "POST", body: streamOf("streamed"), duplex: "half" } as RequestInit]);
    expect(outside).toBe("POST /stream - streamed");
    expect(inside).toBe(outside);
    expect(line).toMatchObject({ method: "POST", status: 200, request_body: { unread: "a stream body, which nukadoko cannot read without taking it from fetch" } });
  });

  it("sends a plain object's FormData body untouched, and names it unread", async () => {
    const form = (): FormData => {
      const data = new FormData();
      data.set("field", "value");
      return data;
    };
    const { outside, inside, line } = await sentBoth(() => [`${base}/form`, { method: "POST", body: form() }]);
    expect(outside).toContain('name="field"');
    expect(inside).toBe(outside);
    expect(line).toMatchObject({ method: "POST", status: 200, request_body: { unread: "a FormData body, which fetch encodes itself" } });
  });

  it("records the body of a Request given as input, with no init", async () => {
    const { outside, inside, line } = await sentBoth(() => [new Request(`${base}/input`, { method: "POST", body: "as input" })]);
    expect(outside).toBe("POST /input - as input");
    expect(inside).toBe(outside);
    expect(line).toMatchObject({ method: "POST", request_body: { text: "as input", bytes: 8 } });
  });
});
