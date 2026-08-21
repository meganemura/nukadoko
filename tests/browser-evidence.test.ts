import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { attachExternalPageEvidence, launchBrowserWithTracing } from "../src/context/browser-evidence.js";
import { createStepContext } from "../src/context/create-context.js";
import { createHttpOmittedCollector } from "../src/context/http-omitted.js";
import { createObservedCollector } from "../src/context/observed.js";
import { createPageEventsCollector } from "../src/context/page-events.js";

// Whether to run at all: computed once at module load (top-level await), so
// `it.skipIf` below sees the real answer instead of the pre-`beforeAll`
// default a hook-based check would leave it at during test collection.
// chromium is expected to already be installed
// (`npx playwright install chromium`); this is only a safety net for an
// environment where that step is genuinely impossible.
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

// Same reasoning as `isChromiumAvailable` above, but for a *headed* launch
// specifically: a CI runner can have
// chromium installed yet no display server to open a window on (a plain
// Linux runner with no Xvfb), which is a `headless: false` launch failing
// while `headless: true` still succeeds. Checked separately, and only when
// the base capability already holds, so the headed-only tests below skip
// themselves rather than fail in that environment.
async function isHeadedChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: false });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const headedChromiumAvailable = chromiumAvailable ? await isHeadedChromiumAvailable() : false;

function baseConfig(overrides: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    browserType: "chromium",
    ...overrides,
  };
}

describe("createStepContext / ctx.page()", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "launches chromium, traces the run, and saves a final screenshot with an ISO 8601 at",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      await page.setContent("<html><body>hello</body></html>");

      const beforeDispose = Date.now();
      const { evidence, storageState } = await dispose();
      const afterDispose = Date.now();

      expect(evidence.trace).toBe("trace.zip");
      // One screenshot only, always
      // named final.png — the former second, per-outcome copy (a "did this
      // fail" fact the step record's own `status` already carries, on a buffer that could
      // already be stale by the time it was taken) is gone.
      expect(evidence.screenshots).toHaveLength(1);
      expect(evidence.screenshots[0]!.file).toBe("final.png");
      const at = Date.parse(evidence.screenshots[0]!.at);
      expect(Number.isNaN(at)).toBe(false);
      // `at` was measured somewhere inside this very `dispose()` call — a
      // real bound, not merely "parses as a date" (value
      // ordering, not only format).
      expect(at).toBeGreaterThanOrEqual(beforeDispose);
      expect(at).toBeLessThanOrEqual(afterDispose);
      expect(existsSync(path.join(evidenceDir, "trace.zip"))).toBe(true);
      expect(existsSync(path.join(evidenceDir, "final.png"))).toBe(true);
      // Only one screenshot file total, by listing the directory rather than
      // asserting a specific other name is absent — the point is that
      // exactly one exists, not the name of whichever second file used to.
      const pngFiles = (await readdir(evidenceDir)).filter((name) => name.endsWith(".png"));
      expect(pngFiles).toEqual(["final.png"]);
      // A browser context was opened, so there is always something to
      // persist for a session, even one with no cookies yet.
      expect(storageState).toBeDefined();
    },
  );

  it.skipIf(!chromiumAvailable)(
    "still resolves dispose() with only real files listed when the step closed the browser itself before throwing",
    async () => {
      // A step's `run` reaches the browser through `ctx.page()`
      // (`page.context().browser()`), so it can close it (or it can crash)
      // before throwing. `runDo` (src/cli/do.ts) always calls dispose() on
      // its way to writing the step record regardless of how `run` ended, so
      // dispose() must never throw here — screenshot/tracing.stop/
      // context.close/browser.close teardown failures are all swallowed
      // (browser-evidence.ts's finalize), and evidence only claims trace.zip
      // when tracing.stop actually got to write it (create-context.ts's
      // dispose).
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      await page.context().browser()?.close();

      const { evidence, storageState } = await dispose();

      expect(evidence.screenshots).toEqual([]);
      expect(evidence.trace).toBeUndefined();
      expect(existsSync(path.join(evidenceDir, "trace.zip"))).toBe(false);
      expect(existsSync(path.join(evidenceDir, "final.png"))).toBe(false);
      // The context was already closed, so collectStorageState() must have
      // swallowed its own failure the same way finalize()'s teardown does.
      expect(storageState).toBeUndefined();
    },
  );

  if (!chromiumAvailable) {
    // Warns rather than silently skipping: only skip
    // when chromium is genuinely unavailable in this environment.
    console.warn(
      "browser-evidence.test.ts: chromium unavailable, browser-path tests skipped",
    );
  } else if (!headedChromiumAvailable) {
    console.warn(
      "browser-evidence.test.ts: headed chromium unavailable (no display?), config.browser headless:false test skipped",
    );
  }
});

// Responsibility: config.browser reaching the real chromium.launch call
// unmodified — measured
// through the browser it actually launches, not assumed from Playwright's
// own documented default. A launched chromium reports "HeadlessChrome" in
// its own User-Agent string when headless and a plain "Chrome" one when
// not (verified by hand against this Playwright version before writing
// these assertions), which is the most direct signal available from inside
// a step's own `ctx.page()` — there is no public Playwright API that asks
// "is this browser headless".
describe("createStepContext / ctx.page(): config.browser controls headless", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-headless-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "launches headless when a project sets no config.browser at all",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      expect(userAgent).toContain("HeadlessChrome");

      await dispose();
    },
  );

  it.skipIf(!headedChromiumAvailable)(
    // Also sets `browserType: "chromium"` explicitly (can be used together
    // with config.browser) —
    // config.browser still reaches launch unmodified when a project names
    // its engine explicitly, not only when browserType is left to default.
    "launches headed when config.browser: { headless: false }, alongside an explicit browserType",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig({ browser: { headless: false }, browserType: "chromium" }),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      expect(userAgent).not.toContain("HeadlessChrome");

      await dispose();
    },
  );
});

// Responsibility: runtime tests — kept to
// exactly the two cases pinned down as chromium-only-safe: explicitly
// selecting "chromium" (the config-load
// half of "unknown value" lives in tests/load-config.test.ts instead, since
// it needs no browser at all). Firefox/webkit are deliberately not
// exercised here — this environment has neither binary installed (by this
// task's own instruction), and `npm run typecheck`/`npm test` must stay
// green without `npx playwright install` ever running.
describe("createStepContext / ctx.page(): browserType", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-type-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    'records the measured engine name and version on dispose() when browserType is explicitly "chromium"',
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig({ browserType: "chromium" }),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      await ctx.page();
      const { browser } = await dispose();

      // Measured, not the declared "chromium" echoed back (create-context.ts's
      // own DisposeResult doc comment): `type` comes from the real `Browser`
      // object's own `browserType().name()`, `version` from its own
      // `version()`.
      expect(browser?.type).toBe("chromium");
      expect(typeof browser?.version).toBe("string");
      expect(browser?.version).not.toBe("");
    },
  );

  it("dispose() carries no browser field when ctx.page() was never called", async () => {
    const { dispose } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
      stepTitle: "no browser step",
    });

    const { browser } = await dispose();
    expect(browser).toBeUndefined();
  });
});

// Responsibility: proves config.browserContext
// actually reaches browser.newContext() rather than only passing schema
// validation — measured by spying on the newContext method of the real
// Browser instance chromium.launch() returns, and reading the arguments it
// was actually called with. There is no simple, environment-independent
// behavioral signal for an option like ignoreHTTPSErrors the way headless
// has (User-Agent), so this measures the pass-through directly instead.
describe("createStepContext / ctx.page(): config.browserContext reaches newContext", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-context-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "passes browserContext straight through, alongside config.baseURL",
    async () => {
      const originalLaunch = chromium.launch.bind(chromium);
      let newContextSpy: ReturnType<typeof vi.spyOn> | undefined;
      const launchSpy = vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
        const browser = await originalLaunch(options);
        newContextSpy = vi.spyOn(browser, "newContext");
        return browser;
      });

      const { ctx, dispose } = createStepContext({
        config: baseConfig({
          baseURL: "http://127.0.0.1:1",
          browserContext: { ignoreHTTPSErrors: true },
        }),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      await ctx.page();

      expect(newContextSpy).toBeDefined();
      expect(newContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({ ignoreHTTPSErrors: true, baseURL: "http://127.0.0.1:1" }),
      );

      await dispose();
      launchSpy.mockRestore();
    },
  );

  it.skipIf(!chromiumAvailable)(
    "passes no extra options to newContext when browserContext is unset (regression)",
    async () => {
      const originalLaunch = chromium.launch.bind(chromium);
      let newContextSpy: ReturnType<typeof vi.spyOn> | undefined;
      const launchSpy = vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
        const browser = await originalLaunch(options);
        newContextSpy = vi.spyOn(browser, "newContext");
        return browser;
      });

      const { ctx, dispose } = createStepContext({
        config: baseConfig({ baseURL: "http://127.0.0.1:1" }),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      await ctx.page();

      expect(newContextSpy).toBeDefined();
      expect(newContextSpy).toHaveBeenCalledWith({ baseURL: "http://127.0.0.1:1" });

      await dispose();
      launchSpy.mockRestore();
    },
  );
});

// Responsibility: the page-side half of measured mutates — a real local
// http server, so
// `ctx.page()` can issue a genuine GET (navigation) and POST (in-page
// fetch), proving `observedCounts()` tallies both. Also now the page-origin
// half of http.jsonl itself: a
// navigation and an in-page `fetch` are both `document`/`fetch`
// resourceTypes, so both are expected to land on http.jsonl, each marked
// `via: "page"` — the assertion this block used to make (that page traffic
// never reaches http.jsonl at all) was this task's own starting point, not
// a fact that survived it. Kept in its own describe block, with its own
// server, rather than folded into the block above: the existing tests there
// use `page.setContent`, deliberately with no navigation and no server.
describe("createStepContext / ctx.page(): observed network writes", () => {
  let evidenceDir: string;
  let server: Server;
  let baseURL: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-observed-"));
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!chromiumAvailable)(
    "counts a page navigation as a read and a page-issued POST as a write, and logs both to http.jsonl as via: page",
    async () => {
      const { ctx, dispose, observedCounts } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      await page.goto(baseURL);
      await page.evaluate(
        async (url) => {
          await fetch(url, { method: "POST" });
        },
        `${baseURL}/`,
      );

      expect(observedCounts()).toEqual({ http_reads: 1, http_writes: 1 });

      const { evidence } = await dispose();
      // Both the navigation (`document`) and the in-page `fetch` land on
      // http.jsonl now — `observed` above
      // is unchanged by that; the two fields answer different questions
      // (this file's own header).
      expect(evidence.http).toBe("http.jsonl");
      const lines = (await readFile(path.join(evidenceDir, "http.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.via).toBe("page");
      }
      expect(lines.some((line) => line.method === "GET")).toBe(true);
      expect(lines.some((line) => line.method === "POST")).toBe(true);
    },
  );
});

// Responsibility: proves the browser-context half of docs/spec.md "Context
// API"'s baseURL wiring —
// `page.goto("/path")` must resolve against `config.baseURL` without the
// step assembling the full URL itself, unlike `ctx.request()`'s own baseURL
// handling (already covered by create-context.test.ts). Own server, own
// describe block, same reasoning as the "observed network writes" block
// above.
describe("createStepContext / ctx.page(): baseURL wired into the browser context", () => {
  let evidenceDir: string;
  let server: Server;
  let baseURL: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-baseurl-"));
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${req.url}</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!chromiumAvailable)(
    'resolves page.goto("/path") against the configured baseURL',
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig({ baseURL }),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      const response = await page.goto("/hello");

      expect(response?.ok()).toBe(true);
      expect(page.url()).toBe(`${baseURL}/hello`);

      await dispose();
    },
  );
});

// Responsibility: the launched browser's own "console" filter — `msg.type()
// !== "error"` returns without recording, so a routine console.log must
// never reach `page_events`. Both messages are fired in the same step so
// the log's absence is evidence (proven by the error entry actually
// landing), not merely an untested default.
describe("createStepContext / ctx.page(): console filtering", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-console-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "does not record a plain console.log as a page event, only the console.error alongside it",
    async () => {
      const { ctx, dispose, pageEventsSnapshot } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
        stepTitle: "browser step",
      });

      const page = await ctx.page();
      const errorSeen = page.context().waitForEvent("console", {
        predicate: (msg) => msg.type() === "error",
        timeout: 10_000,
      });
      await page.setContent(
        `<script>console.log("routine noise")</script><script>console.error("the real one")</script>`,
      );
      await errorSeen;

      const snapshot = pageEventsSnapshot();
      expect(snapshot?.console_errors).toHaveLength(1);
      expect(snapshot?.console_errors?.[0]?.text).toBe("the real one");

      await dispose();
    },
  );
});

// Responsibility: `LaunchBrowserOptions.browserType`'s own documented
// default — `undefined` behaves exactly like `"chromium"` (this file's own
// header). The one production caller (create-context.ts) always passes
// `config.browserType`, which zod defaults to `"chromium"` before this
// function ever sees it, so this fallback is unreached through that one
// caller; `launchBrowserWithTracing` is exported and its own doc comment
// makes a promise about `undefined` specifically, so it is tested directly
// against that promise here.
describe("launchBrowserWithTracing: browserType defaults to chromium when omitted", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-default-engine-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "launches chromium when browserType itself is undefined",
    async () => {
      const handle = await launchBrowserWithTracing({
        evidenceDir,
        observed: createObservedCollector(),
        pageEvents: createPageEventsCollector(),
        logPath: () => path.join(evidenceDir, "http.jsonl"),
        secrets: [],
        httpOmitted: createHttpOmittedCollector(),
      });

      expect(handle.browserInfo.type).toBe("chromium");

      await handle.finalize();
    },
  );
});

// Responsibility: `attachExternalPageEvidence`'s own contract, tested
// directly rather than only through src/external/record-step.ts — a
// `BrowserContext#listenerCount` reading of 0 after `dispose()` cannot tell
// "this handle's own listener was removed" apart from "this handle never
// attached one in the first place"; a second real event landing on the same
// collector instance can.
describe("attachExternalPageEvidence", () => {
  it.skipIf(!chromiumAvailable)(
    "filters a plain console.log the same way the launched path does, and stops recording console errors after dispose()",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const observed = createObservedCollector();
        const pageEvents = createPageEventsCollector();
        const handle = attachExternalPageEvidence(page, { observed, pageEvents });

        const firstConsoleSeen = context.waitForEvent("console", {
          predicate: (msg) => msg.type() === "error",
          timeout: 10_000,
        });
        // `onConsole` here is a separate closure from the launched path's
        // own console handler (createStepContext / ctx.page(): console
        // filtering, above) — the two duplicate the same filter, so this
        // adopted-page path needs its own proof that a routine log never
        // reaches page_events.
        await page.setContent(`<script>console.log("noise")</script><script>console.error("first")</script>`);
        await firstConsoleSeen;
        expect(pageEvents.snapshot()?.console_errors).toHaveLength(1);
        expect(pageEvents.snapshot()?.console_errors?.[0]?.text).toBe("first");

        handle.dispose();

        const secondConsoleSeen = context.waitForEvent("console", {
          predicate: (msg) => msg.type() === "error",
          timeout: 10_000,
        });
        await page.setContent(`<script>console.error("second")</script>`);
        // Waiting for the *context's own* event (not this handle's
        // collector) is what makes this deterministic: it proves the second
        // error really fired, so the collector's own count staying at 1 is
        // evidence dispose() actually removed the listener, not merely that
        // nothing happened yet.
        await secondConsoleSeen;
        expect(pageEvents.snapshot()?.console_errors).toHaveLength(1);
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "dispose() a second time does not throw and removes nothing further",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const observed = createObservedCollector();
        const pageEvents = createPageEventsCollector();
        const handle = attachExternalPageEvidence(page, { observed, pageEvents });

        handle.dispose();
        expect(() => handle.dispose()).not.toThrow();

        const listenerCount = (event: string): number =>
          (context as unknown as { listenerCount(event: string): number }).listenerCount(event);
        expect(listenerCount("request")).toBe(0);
        expect(listenerCount("console")).toBe(0);
        expect(listenerCount("weberror")).toBe(0);
        expect(listenerCount("requestfailed")).toBe(0);
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
});
