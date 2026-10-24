import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the `traceparent` the channel patches add to a request a
// step sends to the world (src/context/channels.ts, observed.ts): through
// `fetch` and `node:http`, only to the world's origin, never over the
// caller's own header, never by changing what the caller passed, one
// trace id per boundary under the world's prefix and one span id per
// request, counted only when the header was added.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const OWN = "00-11111111111111111111111111111111-2222222222222222-01";
const PREFIX = "4bf92f35";

let server: http.Server;
let base: string;
/** The traceparent each request carried, by path. */
const received = new Map<string, string | undefined>();

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((req, res) => {
    const traceparent = req.headers.traceparent;
    received.set(req.url ?? "", typeof traceparent === "string" ? traceparent : undefined);
    res.end("ok");
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
  received.clear();
  dir = await createEmptyTempDir();
  observed = createObservedCollector({
    outputDir: () => path.join(dir, "record"),
    trace: { prefix: PREFIX, origin: base },
  });
});

afterEach(async () => {
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

function httpLines(): { url: string; traceparent?: string }[] {
  try {
    return readFileSync(path.join(dir, "record", "http.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { url: string; traceparent?: string });
  } catch {
    return [];
  }
}

function get(url: string, headers?: http.OutgoingHttpHeaders | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    http.get(url, headers === undefined ? {} : { headers: headers as http.OutgoingHttpHeaders }, (res) => res.resume().on("end", resolve)).on("error", reject);
  });
}

describe("fetch", () => {
  it("adds the boundary's traceparent to a request to the world, and names it on the line", async () => {
    await inStep(async () => {
      await (await fetch(`${base}/a`)).text();
      await (await fetch(`${base}/b`, { method: "POST", body: "x", headers: { "x-from": "step" } })).text();
    });
    await observed.flush();
    const trace = observed.boundaryTrace()!;
    const [a, b] = [TRACEPARENT.exec(received.get("/a") ?? ""), TRACEPARENT.exec(received.get("/b") ?? "")];
    expect(trace.traceId.startsWith(PREFIX)).toBe(true);
    expect([a?.[1], b?.[1]]).toEqual([trace.traceId, trace.traceId]);
    expect(a?.[2]).not.toBe(b?.[2]);
    expect(httpLines().map((line) => line.traceparent)).toEqual([received.get("/a"), received.get("/b")]);
    expect(trace.stamped).toBe(2);
    expect(trace.lastStampAt).toEqual(expect.any(Number));
  });

  it("keeps the caller's own traceparent, and leaves another origin unstamped", async () => {
    await inStep(async () => {
      await (await fetch(`${base}/own`, { headers: { TraceParent: OWN } })).text();
      await fetch("http://127.0.0.1:9/elsewhere").catch(() => undefined);
    });
    await observed.flush();
    expect(received.get("/own")).toBe(OWN);
    expect(httpLines().every((line) => line.traceparent === undefined)).toBe(true);
    expect(observed.boundaryTrace()!.stamped).toBe(0);
  });

  it("gives each boundary a trace id of its own under the world's prefix, and a step that outlives its boundary keeps its trace id", async () => {
    const firstRun = observed.openRun([]);
    await withProcessRecording(firstRun, async () => (await fetch(`${base}/first`)).text());
    const first = observed.boundaryTrace()!;
    observed.close();
    observed.reset();
    // The first boundary's recorder, used after the next boundary began.
    await withProcessRecording(firstRun, async () => (await fetch(`${base}/late`)).text());
    await inStep(async () => (await fetch(`${base}/second`)).text());
    const second = observed.boundaryTrace()!;
    expect(second.traceId).not.toBe(first.traceId);
    expect([first.traceId.slice(0, 8), second.traceId.slice(0, 8)]).toEqual([PREFIX, PREFIX]);
    expect(TRACEPARENT.exec(received.get("/first") ?? "")?.[1]).toBe(first.traceId);
    expect(TRACEPARENT.exec(received.get("/late") ?? "")?.[1]).toBe(first.traceId);
    expect(TRACEPARENT.exec(received.get("/second") ?? "")?.[1]).toBe(second.traceId);
    expect(second.stamped).toBe(1);
  });

  it("stamps nothing for a collector with no world", async () => {
    observed = createObservedCollector({ outputDir: () => path.join(dir, "record") });
    await inStep(async () => (await fetch(`${base}/none`)).text());
    expect(received.get("/none")).toBeUndefined();
    expect(observed.boundaryTrace()).toBeUndefined();
  });
});

describe("node:http", () => {
  it("adds the header to a request to the world, keeps the caller's own, and counts only what it added", async () => {
    await inStep(async () => {
      await get(`${base}/plain`);
      await get(`${base}/own`, { traceparent: OWN });
      // Headers given as an array are sent when the call returns.
      await get(`${base}/array`, ["x-a", "1", "Host", new URL(base).host]);
    });
    await observed.flush();
    const trace = observed.boundaryTrace()!;
    expect(TRACEPARENT.exec(received.get("/plain") ?? "")?.[1]).toBe(trace.traceId);
    expect(received.get("/own")).toBe(OWN);
    expect(received.get("/array")).toBeUndefined();
    expect(trace.stamped).toBe(1);
    expect(httpLines().map((line) => [new URL(line.url).pathname, line.traceparent])).toEqual([
      ["/plain", received.get("/plain")],
      ["/own", undefined],
      ["/array", undefined],
    ]);
  });

  it("stamps nothing outside a step", async () => {
    await get(`${base}/outside`);
    expect(received.get("/outside")).toBeUndefined();
  });
});
