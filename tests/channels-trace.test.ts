import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches, withTraceparent } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the `traceparent` the channel patches add to a request a
// step sends to the world (src/context/channels.ts, observed.ts): through
// `fetch` and `node:http`, only to the world's origin, never over the
// caller's own header, never by rebuilding what the caller passed, one
// trace id for the collector and one span id per boundary, counted only
// when the header was added.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const OWN = "00-11111111111111111111111111111111-2222222222222222-01";

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
    trace: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", origin: base },
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
    const expected = `00-${trace.traceId}-${trace.spanId}-01`;
    expect(received.get("/a")).toBe(expected);
    expect(received.get("/b")).toBe(expected);
    expect(httpLines().map((line) => line.traceparent)).toEqual([expected, expected]);
    expect(trace.stamped).toBe(2);
    expect(trace.lastStampAt).toEqual(expect.any(Number));
  });

  it("keeps the caller's own traceparent, and leaves a Request, a non-plain init, and another origin unstamped", async () => {
    await inStep(async () => {
      await (await fetch(`${base}/own`, { headers: { TraceParent: OWN } })).text();
      await (await fetch(new Request(`${base}/request`))).text();
      class Init {
        get method(): string {
          return "GET";
        }
      }
      await (await fetch(`${base}/class`, new Init() as RequestInit)).text();
      await fetch("http://127.0.0.1:9/elsewhere").catch(() => undefined);
    });
    await observed.flush();
    expect(received.get("/own")).toBe(OWN);
    expect(received.get("/request")).toBeUndefined();
    expect(received.get("/class")).toBeUndefined();
    expect(httpLines().every((line) => line.traceparent === undefined)).toBe(true);
    expect(observed.boundaryTrace()!.stamped).toBe(0);
  });

  it("gives each boundary a span of its own under one trace id, and a step that outlives its boundary keeps its span", async () => {
    const firstRun = observed.openRun([]);
    await withProcessRecording(firstRun, async () => (await fetch(`${base}/first`)).text());
    const first = observed.boundaryTrace()!;
    observed.close();
    observed.reset();
    // The first boundary's recorder, used after the next boundary began.
    await withProcessRecording(firstRun, async () => (await fetch(`${base}/late`)).text());
    await inStep(async () => (await fetch(`${base}/second`)).text());
    const second = observed.boundaryTrace()!;
    expect(second.traceId).toBe(first.traceId);
    expect(second.spanId).not.toBe(first.spanId);
    expect([...second.otherSpans]).toEqual([first.spanId]);
    expect(TRACEPARENT.exec(received.get("/late") ?? "")?.[2]).toBe(first.spanId);
    expect(TRACEPARENT.exec(received.get("/second") ?? "")?.[2]).toBe(second.spanId);
    expect(second.stamped).toBe(1);
  });

  it("stamps nothing for a collector with no world", async () => {
    observed = createObservedCollector({ outputDir: () => path.join(dir, "record") });
    await inStep(async () => (await fetch(`${base}/none`)).text());
    expect(received.get("/none")).toBeUndefined();
    expect(observed.boundaryTrace()).toBeUndefined();
  });
});

describe("withTraceparent", () => {
  const value = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const name = gs.text({ alphabet: "abcdefxyz-", minSize: 1, maxSize: 8 }).filter((text) => text !== "traceparent");
  const headerValue = gs.text({ alphabet: "abc 123;=", maxSize: 8 }).map((text) => text.trim());

  it("adds the header to plain headers and keeps every other header and init member as the caller passed it", () =>
    hegel.test((tc) => {
      const headers = Object.fromEntries(tc.draw(gs.arrays(gs.tuples(name, headerValue), { maxSize: 5 })));
      const signal = new AbortController().signal;
      const init = { method: tc.draw(gs.sampledFrom(["GET", "POST", "PUT"])), headers, signal, keepalive: tc.draw(gs.booleans()) };
      const stamped = withTraceparent(["http://localhost:1/x", init], () => value)!;
      const [input, sent] = stamped.args;
      expect(input).toBe("http://localhost:1/x");
      expect(stamped.traceparent).toBe(value);
      expect(sent?.method).toBe(init.method);
      expect(sent?.signal).toBe(signal);
      expect(sent?.keepalive).toBe(init.keepalive);
      const result = new Headers(sent?.headers);
      expect(result.get("traceparent")).toBe(value);
      expect(Object.fromEntries([...result].filter(([key]) => key !== "traceparent"))).toEqual(Object.fromEntries([...new Headers(headers)]));
    }));

  it("leaves the arguments alone where adding a header would change them", () => {
    const stamp = (): string => value;
    expect(withTraceparent(["http://localhost:1/x", { headers: [["traceparent", OWN]] }], stamp)).toBeUndefined();
    expect(withTraceparent([new Request("http://localhost:1/x")], stamp)).toBeUndefined();
    expect(withTraceparent(["http://localhost:1/x", new Request("http://localhost:1/x") as unknown as RequestInit], stamp)).toBeUndefined();
    expect(withTraceparent(["http://localhost:1/x", { headers: { "bad header": "x" } }], stamp)).toBeUndefined();
    expect(withTraceparent(["http://localhost:1/x"], () => undefined)).toBeUndefined();
    // Headers and arrays of pairs are read, not copied by reference.
    const fromHeaders = withTraceparent(["http://localhost:1/x", { headers: new Headers({ a: "1" }) }], stamp)!;
    expect([...new Headers(fromHeaders.args[1]?.headers)]).toEqual([
      ["a", "1"],
      ["traceparent", value],
    ]);
    expect(withTraceparent([new URL("http://localhost:1/x")], stamp)?.args[1]?.headers).toEqual(new Headers({ traceparent: value }));
  });

  it("asks for a value only once the header will be added, so the count is of requests that carry one", () => {
    let asked = 0;
    const stamp = (): string => {
      asked += 1;
      return value;
    };
    withTraceparent(["http://localhost:1/x", { headers: { traceparent: OWN } }], stamp);
    withTraceparent([new Request("http://localhost:1/x")], stamp);
    expect(asked).toBe(0);
    withTraceparent(["http://localhost:1/x"], stamp);
    expect(asked).toBe(1);
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
    expect(received.get("/plain")).toBe(`00-${trace.traceId}-${trace.spanId}-01`);
    expect(received.get("/own")).toBe(OWN);
    expect(received.get("/array")).toBeUndefined();
    expect(trace.stamped).toBe(1);
    expect(httpLines().map((line) => [new URL(line.url).pathname, line.traceparent])).toEqual([
      ["/plain", `00-${trace.traceId}-${trace.spanId}-01`],
      ["/own", undefined],
      ["/array", undefined],
    ]);
  });

  it("stamps nothing outside a step", async () => {
    await get(`${base}/outside`);
    expect(received.get("/outside")).toBeUndefined();
  });
});
