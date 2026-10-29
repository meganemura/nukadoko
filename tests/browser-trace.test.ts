import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { fetchPatternsOf, stampPageRequests } from "../src/context/browser-trace.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: the `traceparent` a Chromium page's requests to the
// world carry (src/context/browser-trace.ts), measured through a step
// context with a world URL. What stamping must not change is measured
// too: an image the page loaded stays cached on the next navigation, a
// cross-origin request to the world gets no preflight, cookies still go,
// and a route the step adds itself still works.

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const OWN = "00-11111111111111111111111111111111-2222222222222222-01";

function config(): NukadokoConfig {
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
  };
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly traceparent: string | undefined;
  readonly cookie: string | undefined;
}

// Makes the real session refuse Fetch.enable with `reason`, in
// Playwright's words. Chromium 141.0.7390.37 refuses a filter that names
// EventSource with "Unknown resource type in fetch filter: 'EventSource'";
// a newer Chromium accepts it, so the test puts that refusal on its
// session.
function refuseFetchEnable(context: BrowserContext, refusal: (types: readonly string[]) => string | undefined): void {
  const open = context.newCDPSession.bind(context);
  context.newCDPSession = async (page) => {
    const session = await open(page);
    const send = session.send.bind(session);
    session.send = (async (method: string, params?: { patterns?: { resourceType?: string }[] }) => {
      const reason = method === "Fetch.enable" ? refusal((params?.patterns ?? []).map((pattern) => pattern.resourceType ?? "")) : undefined;
      if (reason !== undefined) throw new Error(`cdpSession.send: Protocol error (Fetch.enable): ${reason}`);
      return send(method as "Fetch.enable", params as never);
    }) as typeof session.send;
    return session;
  };
}

function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe.skipIf(!chromiumAvailable)("a page's requests to the world", () => {
  let evidenceDir: string;
  let world: { server: Server; origin: string };
  let other: { server: Server; origin: string };
  const hits: Hit[] = [];

  beforeEach(async () => {
    hits.length = 0;
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-trace-"));
    world = await listen((req, res) => {
      hits.push({ method: req.method ?? "", path: req.url ?? "", traceparent: header(req.headers.traceparent), cookie: req.headers.cookie });
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=abc" });
        res.end('<img src="/image.svg"><script>fetch("/api").then((r) => r.text()).then((t) => { document.title = t; })</script>');
      } else if (req.url === "/image.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
      } else if (req.url === "/live") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<script>fetch("/api"); new EventSource("/events").onmessage = (event) => { document.title = event.data; };</script>');
      } else if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("retry: 600000\ndata: live\n\n");
      } else if (req.method === "OPTIONS") {
        // Simple CORS only: a preflight is refused.
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("from-world");
      }
    });
    other = await listen((req, res) => {
      hits.push({ method: req.method ?? "", path: `other${req.url ?? ""}`, traceparent: header(req.headers.traceparent), cookie: undefined });
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<script>fetch("${world.origin}/cross").then((r) => r.text()).then((t) => { document.title = t; }, (e) => { document.title = "failed " + e; })</script>`);
    });
  });

  afterEach(async () => {
    for (const { server } of [world, other]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("stamps the page's document and fetch with the boundary's trace id, and keeps the cache, CORS, and cookies as they were", async () => {
    const handle = createStepContext({ config: config(), baseURL: world.origin, evidenceDir, env: {}, stepTitle: "page step" });
    try {
      await handle.beginStep(path.join(evidenceDir, "one"), "one");
      const page = await handle.ctx.page();
      await page.goto("/page");
      await page.waitForFunction('document.title !== ""');
      await page.goto("/page");
      await page.waitForFunction('document.title !== ""');
      await handle.observedSnapshot();
      await handle.endStep();
      const first = hits.splice(0);

      // The image loaded once: the second navigation took it from the cache.
      expect(first.map((hit) => hit.path)).toEqual(["/page", "/image.svg", "/api", "/page", "/api"]);
      const stamped = first.filter((hit) => hit.path !== "/image.svg").map((hit) => TRACEPARENT.exec(hit.traceparent ?? ""));
      const traces = new Set(stamped.map((match) => match?.[1]));
      expect(traces.size).toBe(1);
      expect([...traces][0]).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
      // A span id per request.
      expect(new Set(stamped.map((match) => match?.[2])).size).toBe(stamped.length);
      // An image is not stamped (module header), and every request after
      // the first navigation still carried the cookie it set.
      expect(first.find((hit) => hit.path === "/image.svg")?.traceparent).toBeUndefined();
      expect(first.slice(1).every((hit) => hit.cookie === "sid=abc")).toBe(true);

      await handle.beginStep(path.join(evidenceDir, "two"), "two");
      await page.goto(`${other.origin}/`);
      await page.waitForFunction('document.title !== ""');
      expect(await page.title()).toBe("from-world");
      const second = hits.splice(0);
      // The other origin got no header, and the cross-origin request to the
      // world went with no preflight, under the new step's trace id, which
      // starts with the same prefix as the first step's.
      expect(second.map((hit) => [hit.method, hit.path, hit.traceparent === undefined])).toEqual([
        ["GET", "other/", true],
        ["GET", "/cross", false],
      ]);
      const [, trace] = TRACEPARENT.exec(second[1]!.traceparent!) ?? [];
      expect(trace).not.toBe([...traces][0]);
      expect(trace?.slice(0, 8)).toBe([...traces][0]?.slice(0, 8));
    } finally {
      await handle.dispose();
    }
  });

  it("stamps a page the step opens from its first request, and leaves a route of the step's own working", async () => {
    const handle = createStepContext({ config: config(), baseURL: world.origin, evidenceDir, env: {}, stepTitle: "page step" });
    try {
      const page = await handle.ctx.page();
      const opened = await page.context().newPage();
      await opened.goto("/page");
      await opened.waitForFunction('document.title !== ""');
      expect(hits.filter((hit) => hit.path !== "/image.svg").map((hit) => [hit.path, TRACEPARENT.test(hit.traceparent ?? "")])).toEqual([
        ["/page", true],
        ["/api", true],
      ]);
      hits.length = 0;
      await opened.route("**/api", (route) => route.fulfill({ body: "fulfilled" }));
      await opened.goto("/page");
      await opened.waitForFunction('document.title !== ""');
      expect(await opened.title()).toBe("fulfilled");
      await opened.unroute("**/api");
      await opened.route("**/api", (route) => route.continue());
      await opened.evaluate((own) => fetch("/api", { headers: { traceparent: own } }), OWN);
      expect(hits.at(-1)).toEqual(expect.objectContaining({ path: "/api", traceparent: OWN }));
    } finally {
      await handle.dispose();
    }
  });

  it("stamps a page's document, fetch, and EventSource on a Chromium that refuses EventSource in a Fetch filter", async () => {
    const handle = createStepContext({ config: config(), baseURL: world.origin, evidenceDir, env: {}, stepTitle: "page step" });
    try {
      await handle.beginStep(path.join(evidenceDir, "one"), "one");
      const page = await handle.ctx.page();
      refuseFetchEnable(page.context(), (types) => (types.includes("EventSource") ? "Unknown resource type in fetch filter: 'EventSource'" : undefined));
      const opened = await page.context().newPage();
      await opened.goto("/live");
      await opened.waitForFunction('document.title === "live"');
      expect(hits.map((hit) => [hit.path, TRACEPARENT.test(hit.traceparent ?? "")]).sort()).toEqual([
        ["/api", true],
        ["/events", true],
        ["/live", true],
      ]);
      expect((await handle.observedSnapshot()).unmeasured).toEqual([]);
      await handle.endStep();
    } finally {
      await handle.dispose();
    }
  });

  it("names a page's requests it could not stamp when the DevTools session refuses Fetch, in each step that sent one", async () => {
    const handle = createStepContext({ config: config(), baseURL: world.origin, evidenceDir, env: {}, stepTitle: "page step" });
    try {
      await handle.beginStep(path.join(evidenceDir, "one"), "one");
      const page = await handle.ctx.page();
      refuseFetchEnable(page.context(), () => "Internal error");
      const opened = await page.context().newPage();
      await opened.goto(`${other.origin}/`);
      await opened.waitForFunction('document.title !== ""');
      expect(hits.map((hit) => [hit.path, hit.traceparent])).toEqual([
        ["other/", undefined],
        ["/cross", undefined],
      ]);
      expect((await handle.observedSnapshot()).unmeasured).toEqual([
        {
          kind: "page_request",
          detail: "requests a page sends to the world go without a traceparent: cdpSession.send: Protocol error (Fetch.enable): Internal error",
        },
      ]);
      await handle.endStep();

      // A step whose page sent nothing to the world has nothing to name.
      await handle.beginStep(path.join(evidenceDir, "two"), "two");
      expect((await handle.observedSnapshot()).unmeasured).toEqual([]);
      await handle.endStep();
    } finally {
      await handle.dispose();
    }
  });
});

describe.skipIf(!chromiumAvailable)("a world at localhost", () => {
  let evidenceDir: string;
  let server: Server;
  const seen: (string | undefined)[] = [];

  beforeEach(async () => {
    seen.length = 0;
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-trace-"));
    server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url} ${header(req.headers.traceparent) === undefined ? "-" : "stamped"}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hi</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("stamps a page on a name below localhost at the world's port, where a project keeps one person's cookies", async () => {
    const port = (server.address() as AddressInfo).port;
    const handle = createStepContext({ config: config(), baseURL: `http://localhost:${port}`, evidenceDir, env: {}, stepTitle: "page step" });
    try {
      const page = await handle.ctx.page();
      await page.goto(`http://aki.localhost:${port}/rooms`);
      expect(seen).toEqual([`aki.localhost:${port} /rooms stamped`]);
    } finally {
      await handle.dispose();
    }
  });
});

describe("stampPageRequests", () => {
  it("matches the world's origin, and every name below localhost at its port, with the wildcards escaped", () => {
    expect(fetchPatternsOf("http://localhost:41873")).toEqual(["http://localhost:41873/*", "http://*.localhost:41873/*"]);
    expect(fetchPatternsOf("https://staging.example.test")).toEqual(["https://staging.example.test/*"]);
    expect(fetchPatternsOf("http://127.0.0.1:3100")).toEqual(["http://127.0.0.1:3100/*"]);
  });

  it("does nothing for an engine with no DevTools protocol", async () => {
    let subscribed = false;
    const context = {
      on: () => {
        subscribed = true;
      },
      pages: () => [],
    } as unknown as Parameters<typeof stampPageRequests>[0];
    const stamping = stampPageRequests(context, "firefox", { origin: "http://localhost:1", traceparentFor: () => "x", unstamped: () => undefined });
    await stamping.attach({} as Parameters<typeof stamping.attach>[0]);
    expect(subscribed).toBe(false);
  });
});
