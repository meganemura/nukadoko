import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Whether to run at all: computed once at module load (top-level await), so
// `it.skipIf` below sees the real answer instead of the pre-`beforeAll`
// default a hook-based check would leave it at during test collection. Per
// the task spec: chromium is expected to already be installed
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
// specifically (t6-config-browser task spec, tests): a CI runner can have
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
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    secrets: { public: [] },
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
    "launches chromium, traces the run, and saves a final screenshot",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
      });

      const page = await ctx.page();
      await page.setContent("<html><body>hello</body></html>");

      const { evidence, storageState } = await dispose("ok");

      expect(evidence.trace).toBe("trace.zip");
      expect(evidence.screenshots).toEqual(["final.png"]);
      expect(existsSync(path.join(evidenceDir, "trace.zip"))).toBe(true);
      expect(existsSync(path.join(evidenceDir, "final.png"))).toBe(true);
      // A browser context was opened, so there is always something to
      // persist for a session, even one with no cookies yet (this task's
      // spec, decision 2).
      expect(storageState).toBeDefined();
    },
  );

  it.skipIf(!chromiumAvailable)(
    "additionally saves failure.png when the execution failed",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
      });

      const page = await ctx.page();
      await page.setContent("<html><body>hello</body></html>");

      const { evidence } = await dispose("failed");

      expect(evidence.screenshots.sort()).toEqual(["failure.png", "final.png"]);
      expect(existsSync(path.join(evidenceDir, "failure.png"))).toBe(true);
    },
  );

  it.skipIf(!chromiumAvailable)(
    "still resolves dispose() with only real files listed when the step closed the browser itself before throwing",
    async () => {
      // A step's `run` reaches the browser through `ctx.page()`
      // (`page.context().browser()`), so it can close it (or it can crash)
      // before throwing. `runDo` (src/cli/do.ts) always calls dispose() on
      // its way to writing the receipt regardless of how `run` ended, so
      // dispose() must never throw here — screenshot/tracing.stop/
      // context.close/browser.close teardown failures are all swallowed
      // (browser-evidence.ts's finalize), and evidence only claims trace.zip
      // when tracing.stop actually got to write it (create-context.ts's
      // dispose).
      const { ctx, dispose } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
      });

      const page = await ctx.page();
      await page.context().browser()?.close();

      const { evidence, storageState } = await dispose("failed");

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
    // Surfaced in the implementer's report, per the task spec: only skip
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
// unmodified (t6-config-browser task spec, decision 4 and tests) — measured
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
      });

      const page = await ctx.page();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      expect(userAgent).toContain("HeadlessChrome");

      await dispose("ok");
    },
  );

  it.skipIf(!headedChromiumAvailable)(
    "launches headed when config.browser: { headless: false }",
    async () => {
      const { ctx, dispose } = createStepContext({
        config: baseConfig({ browser: { headless: false } }),
        evidenceDir,
        env: {},
      });

      const page = await ctx.page();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      expect(userAgent).not.toContain("HeadlessChrome");

      await dispose("ok");
    },
  );
});

// Responsibility: the page-side half of measured mutates (m2pre-observed
// task spec, scope item 2 and decision 2) — a real local http server, so
// `ctx.page()` can issue a genuine GET (navigation) and POST (in-page
// fetch), proving `observedCounts()` tallies both and that neither ever
// reaches http.jsonl (that file stays `ctx.request()`'s own record,
// docs/spec.md "Receipts"). Kept in its own describe block, with its own
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
    "counts a page navigation as a read and a page-issued POST as a write, without adding either to http.jsonl",
    async () => {
      const { ctx, dispose, observedCounts } = createStepContext({
        config: baseConfig(),
        evidenceDir,
        env: {},
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

      const { evidence } = await dispose("ok");
      // `ctx.request()` was never called this run — page traffic must not
      // have been folded into http.jsonl (this task's spec, scope item 2).
      expect(evidence.http).toBeUndefined();
      expect(existsSync(path.join(evidenceDir, "http.jsonl"))).toBe(false);
    },
  );
});

// Responsibility: proves the browser-context half of docs/spec.md "Context
// API"'s baseURL wiring (m2pre-ctx-surface task spec, decision 3) —
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
      });

      const page = await ctx.page();
      const response = await page.goto("/hello");

      expect(response?.ok()).toBe(true);
      expect(page.url()).toBe(`${baseURL}/hello`);

      await dispose("ok");
    },
  );
});
