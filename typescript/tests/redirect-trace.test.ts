import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { installChannelPatches, traceparentIn } from "../src/context/channels.js";
import { createStepContext } from "../src/context/create-context.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";

// Responsibility: where the `traceparent` nukadoko adds goes when a
// request is redirected (src/context/channels.ts, http-log.ts). `fetch`
// gets it on each hop to the world, and never on a hop to another origin;
// the caller's arguments go untouched, so a Request and a non-plain init
// are stamped too. A Playwright request context sends a call's headers on
// to the redirect's origin, which nukadoko cannot stop, so the line names
// that origin. A traceparent the request context's extraHTTPHeaders set
// is the caller's own and is kept.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const OWN = "00-11111111111111111111111111111111-2222222222222222-01";

interface Hit {
  readonly server: "world" | "other";
  readonly path: string;
  readonly traceparent: string | undefined;
}

function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

let world: { server: Server; origin: string };
let other: { server: Server; origin: string };
const hits: Hit[] = [];
let dir: string;

beforeAll(() => {
  installChannelPatches();
});

beforeEach(async () => {
  hits.length = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-redirect-trace-"));
  other = await listen((req, res) => {
    hits.push({ server: "other", path: req.url ?? "", traceparent: req.headers.traceparent as string | undefined });
    res.end("other");
  });
  world = await listen((req, res) => {
    hits.push({ server: "world", path: req.url ?? "", traceparent: req.headers.traceparent as string | undefined });
    if (req.url === "/away") {
      res.writeHead(302, { location: `${other.origin}/landing` });
      res.end();
    } else if (req.url === "/inner") {
      res.writeHead(302, { location: "/final" });
      res.end();
    } else {
      res.end("world");
    }
  });
});

afterEach(async () => {
  for (const { server } of [world, other]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
});

function linesIn(file: string): { url: string; traceparent?: string; traceparent_sent_to?: string[] }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { url: string; traceparent?: string; traceparent_sent_to?: string[] });
}

describe("fetch across a redirect", () => {
  let observed: ObservedCollector;

  beforeEach(() => {
    observed = createObservedCollector({ outputDir: () => path.join(dir, "record"), trace: { prefix: "4bf92f35", origin: world.origin } });
  });

  it("stamps each hop to the world with one value per call, and no hop to another origin", async () => {
    await withProcessRecording(observed.openRun([]), async () => {
      await (await fetch(`${world.origin}/away`)).text();
      await (await fetch(`${world.origin}/inner`)).text();
    });
    await observed.flush();

    expect(hits.map((hit) => [hit.server, hit.path, hit.traceparent !== undefined])).toEqual([
      ["world", "/away", true],
      ["other", "/landing", false],
      ["world", "/inner", true],
      ["world", "/final", true],
    ]);
    const [away, , inner, final] = hits;
    expect(inner!.traceparent).toBe(final!.traceparent);
    expect(TRACEPARENT.exec(away!.traceparent!)?.[1]).toBe(observed.boundaryTrace()!.traceId);
    expect(observed.boundaryTrace()!.stamped).toBe(2);
    // The line names where the id went: the world's hops, never the final
    // URL's origin when the id did not reach it.
    expect(linesIn(path.join(dir, "record", "http.jsonl")).map((line) => [new URL(line.url).pathname, line.traceparent, line.traceparent_sent_to])).toEqual([
      ["/landing", away!.traceparent, [world.origin]],
      ["/final", inner!.traceparent, [world.origin]],
    ]);
  });

  it("names the caller's own traceparent and every origin it reached on a redirect", async () => {
    await withProcessRecording(observed.openRun([]), async () => {
      await (await fetch(`${world.origin}/away`, { headers: { traceparent: OWN } })).text();
    });
    await observed.flush();
    expect(hits.map((hit) => [hit.server, hit.traceparent])).toEqual([
      ["world", OWN],
      ["other", OWN],
    ]);
    expect(observed.boundaryTrace()!.stamped).toBe(0);
    expect(linesIn(path.join(dir, "record", "http.jsonl")).map((line) => [line.traceparent, line.traceparent_sent_to])).toEqual([
      [OWN, [world.origin, other.origin]],
    ]);
  });

  it("stamps a Request and a non-plain init without changing them, and keeps the caller's own traceparent on every hop", async () => {
    const request = new Request(`${world.origin}/request`, { headers: { "x-from": "step" } });
    class Init {
      get method(): string {
        return "GET";
      }
    }
    await withProcessRecording(observed.openRun([]), async () => {
      await (await fetch(request)).text();
      await (await fetch(`${world.origin}/class`, new Init() as RequestInit)).text();
      await (await fetch(`${world.origin}/inner`, { headers: { traceparent: OWN } })).text();
    });
    await observed.flush();

    expect(hits.map((hit) => [hit.path, hit.traceparent === OWN ? "own" : TRACEPARENT.test(hit.traceparent ?? "") ? "stamped" : "none"])).toEqual([
      ["/request", "stamped"],
      ["/class", "stamped"],
      ["/inner", "own"],
      ["/final", "own"],
    ]);
    expect([...request.headers]).toEqual([["x-from", "step"]]);
    expect(observed.boundaryTrace()!.stamped).toBe(2);
  });

  it("stamps nothing outside a step", async () => {
    await (await fetch(`${world.origin}/inner`)).text();
    expect(hits.every((hit) => hit.traceparent === undefined)).toBe(true);
  });
});

describe("traceparentIn", () => {
  const name = gs.sampledFrom(["accept", "x-a", "traceparent", "TraceParent", "tracestate", "traceparent-x"]);

  it("finds the first traceparent's value among a flat array of header pairs, in any case, and in header text", () =>
    hegel.test((tc) => {
      const pairs = tc.draw(gs.arrays(gs.tuples(name, gs.sampledFrom(["1", "traceparent", OWN])), { maxSize: 5 }));
      const expected = pairs.find(([key]) => key.toLowerCase() === "traceparent")?.[1];
      expect(traceparentIn(pairs.flat())).toBe(expected);
      expect(traceparentIn(pairs.map(([key, value]) => `${key}: ${value}\r\n`).join(""))).toBe(expected);
      expect(traceparentIn(`GET / HTTP/1.1\r\n${pairs.map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`)).toBe(expected);
    }));

  it("finds none in what is not a header list", () => {
    expect(traceparentIn(undefined)).toBeUndefined();
    expect(traceparentIn({ traceparent: OWN })).toBeUndefined();
  });
});

function config(over: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    retention: { runs: 20, adHocDays: 7 },
    stepTimeout: 1_200_000,
    browserType: "chromium",
    worldParameters: {},
    ...over,
  };
}

describe("a Playwright request context across a redirect", () => {
  it("names the origin a redirect took the added traceparent to, and keeps one the context's extraHTTPHeaders set", async () => {
    const stamped = createStepContext({ config: config(), baseURL: world.origin, evidenceDir: dir, env: {}, stepTitle: "request step" });
    const own = createStepContext({
      config: config({ requestContext: { extraHTTPHeaders: { traceparent: OWN } } }),
      baseURL: world.origin,
      evidenceDir: path.join(dir, "own"),
      env: {},
      stepTitle: "own step",
    });
    try {
      await stamped.beginStep(path.join(dir, "one"), "one");
      await stamped.recordingProcesses(async () => {
        const request = await stamped.ctx.request();
        await request.get("/away");
        await request.get("/plain");
      });
      await stamped.observedSnapshot();
      const lines = linesIn(path.join(dir, "one", "http.jsonl"));
      expect(lines.map((line) => [line.url, TRACEPARENT.test(line.traceparent ?? ""), line.traceparent_sent_to])).toEqual([
        [`${other.origin}/landing`, true, [world.origin, other.origin]],
        [`${world.origin}/plain`, true, [world.origin]],
      ]);
      // Playwright sent the header on with the redirect; the line says so.
      expect(hits.find((hit) => hit.server === "other")?.traceparent).toBe(lines[0]!.traceparent);

      hits.length = 0;
      await own.beginStep(path.join(dir, "two"), "two");
      await own.recordingProcesses(async () => (await own.ctx.request()).get("/plain"));
      await own.observedSnapshot();
      expect(hits.map((hit) => hit.traceparent)).toEqual([OWN]);
      const [ownLine] = linesIn(path.join(dir, "two", "http.jsonl"));
      expect([ownLine!.traceparent, ownLine!.traceparent_sent_to]).toEqual([OWN, [world.origin]]);
    } finally {
      await stamped.dispose();
      await own.dispose();
    }
  });
});
