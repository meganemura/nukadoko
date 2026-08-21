import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, request as playwrightRequest, type APIRequestContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarvest } from "../src/cli/harvest.js";
import { experimental_recordStep, UnsupportedExternalFixtureError } from "../src/external/record-step.js";
import { readStepRecord } from "../src/record/read-step-record.js";
import type { StepRecord } from "../src/record/types.js";
import { defineStep } from "../src/step/define-step.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the acceptance points the task that added
// `experimental_recordStep` named as required — a step run from inside a
// Playwright Test spec (here, against a real `APIRequestContext` built the
// same way that spec's own `request` fixture is, since the function itself
// cannot tell the two apart) writes a `kind: "external"` step record `nuka
// harvest` can consume, its args/returns pass through the step's own
// schema, the injected request context survives the call (never disposed
// by this module), and a secret is redacted out of http.jsonl. A
// `page`/`context`-needing step is refused before any record exists when no
// `options.page` was given — the `describe("experimental_recordStep: page"`
// block below covers the case an `options.page` was, pinning the "no trace,
// no screenshot for a page this module did not launch" rule this
// experimental surface promises (its own header, src/external/
// record-step.ts).
//
// `openCartStep` here is a plain-JS twin of the fixture project's own
// features/steps/open-cart.ts (pattern/args/returns kept identical by
// hand): `nuka harvest`'s own vocabulary comes from discovering that
// on-disk file, so it never needs to be the same JS object this test
// actually runs — only the same name, pattern, and schema shape, the same
// way a Playwright spec's own imported step and nukadoko's discovered copy
// of it are two different module instances already (see create-context.ts's
// header on `resultOf`'s own realm-identity note).

const openCartArgs = z.object({});
const openCartReturns = z.object({ id: z.string() });

const openCartStep = defineStep({
  pattern: "a cart is opened",
  description: "Open a new cart",
  args: openCartArgs,
  returns: openCartReturns,
  mutates: true,
  async run({ request, requireEnv }) {
    const token = requireEnv("API_TOKEN");
    const res = await request.post(`/carts?token=${token}`);
    return openCartReturns.parse(await res.json());
  },
});

function startCartServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    let counter = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/carts")) {
        counter += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `cart-${counter}` }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function startPageServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

// Whether to run the `options.page`-adoption tests at all — computed once at
// module load (top-level await), the same reasoning and pattern
// tests/browser-evidence.test.ts's own `isChromiumAvailable` already
// follows: chromium is expected to already be installed (`npx playwright
// install chromium`), this is only a safety net for an environment where
// that is genuinely impossible.
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

describe("experimental_recordStep", () => {
  let server: Server;
  let url: string;
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    ({ server, url } = await startCartServer());
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext({ baseURL: url });
  });

  afterEach(async () => {
    await requestContext.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  function stepRecordDir(recordId: string): string {
    return path.join(rootDir, ".nukadoko", "records", "steps", recordId);
  }

  it("runs the step, validates args/returns against its own schema, and writes a kind: external step record", async () => {
    const { result, stepRecordId } = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    expect(result).toEqual({ id: "cart-1" });

    const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
    expect(record).not.toBeNull();
    expect(record.kind).toBe("external");
    expect(record.step).toBe("open-cart");
    expect(record.status).toBe("ok");
    expect(record.scenario_record_id).toBeNull();
    expect(record.run_id).toBeNull();
    // No trace/screenshot: this surface never opens a browser of its own,
    // so there is nothing here that would duplicate the calling Playwright
    // spec's own evidence (src/external/record-step.ts's own header).
    expect(record.evidence.trace).toBeUndefined();
    expect(record.evidence.screenshots).toEqual([]);
  });

  it("refuses bad args before running the step, still against the step's own schema", async () => {
    await expect(
      experimental_recordStep(
        openCartStep,
        // @ts-expect-error deliberately the wrong type, to exercise the runtime refusal
        "not-an-object",
        { name: "open-cart", rootDir, request: requestContext },
      ),
    ).rejects.toThrow(/args validation failed/);
  });

  it("rejects a missing required args key at compile time when options has no use", async () => {
    // A local step whose `args` has a required key, unlike `openCartStep`
    // above (`z.object({})`, which cannot demonstrate a missing key). This
    // call passes no `options.use`, so the strict overload of
    // `experimental_recordStep` applies and `args` must satisfy
    // `requiresCartIdStep.args` exactly; the line below omits the required
    // `cartId` key, which the type checker must reject. If the strict
    // overload ever stopped applying (a regression back to the single,
    // loosened `Partial` signature), this `@ts-expect-error` would itself
    // fail `npm run typecheck` for reporting an unused suppression.
    const requiresCartIdStep = defineStep({
      description: "requires a cartId, to exercise the strict-overload compile check",
      args: z.object({ cartId: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });

    await expect(
      // @ts-expect-error missing required key `cartId`, to prove the strict overload (no `use`) still catches this at compile time. Kept on one line: which parameter TypeScript blames for an overload mismatch is not stable, but the whole call sits on this one line either way.
      experimental_recordStep(requiresCartIdStep, {}, { name: "requires-cart-id", rootDir, request: requestContext }),
    ).rejects.toThrow(/args validation failed/);
  });

  it("never disposes the injected request context: a second call through the same context still succeeds", async () => {
    const first = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const second = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    expect(first.result).toEqual({ id: "cart-1" });
    expect(second.result).toEqual({ id: "cart-2" });

    // The two records this test just produced are exactly `nuka harvest`'s
    // own input — given out of the order they ran in, on purpose, since
    // harvest is documented to re-sort by `started_at` itself.
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runHarvest({
      rootDir,
      stepRecordIds: [second.stepRecordId, first.stepRecordId],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stderr.text()).not.toContain("no such step record");
    expect(stderr.text()).not.toContain("belongs to a `nuka run` scenario");

    const lines = stdout
      .text()
      .split("\n")
      .filter((line) => line.trim().startsWith("*"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a cart is opened");
    expect(lines[1]).toContain("a cart is opened");
  });

  it("redacts the API token from http.jsonl but the returned result stays the real value", async () => {
    const { result, stepRecordId } = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    expect(result).toEqual({ id: "cart-1" });

    const httpLog = await readFile(path.join(stepRecordDir(stepRecordId), "http.jsonl"), "utf8");
    expect(httpLog).toContain("{{secret.API_TOKEN}}");
    expect(httpLog).not.toContain("super-secret-external-driver-token");
  });

  it("refuses a step needing `page` before any step record exists", async () => {
    const needsPageStep = defineStep({
      description: "needs a browser page, not supported by this driver yet",
      args: z.object({}),
      returns: z.object({}),
      async run({ page }) {
        await page.title();
        return {};
      },
    });

    await expect(
      experimental_recordStep(needsPageStep, {}, { name: "needs-page", rootDir, request: requestContext }),
    ).rejects.toBeInstanceOf(UnsupportedExternalFixtureError);

    // Nothing this call could have written a record for: the refusal fires
    // before `recordId`/`evidenceDir` are ever created.
    expect(existsSync(path.join(rootDir, ".nukadoko", "records", "steps"))).toBe(false);
  });
});

// Responsibility: the acceptance points m12 (an injected `page`, not only
// `request`) added to `experimental_recordStep` — a real chromium page,
// adopted rather than launched by this module (src/context/
// browser-evidence.ts's `attachExternalPageEvidence`, wired in through
// src/context/create-context.ts's own `page` option): the step's own
// `run({ page })` receives that exact page, page-issued traffic is counted
// in `observed`, no trace/screenshot lands on the record (the calling
// Playwright Test spec already owns both for this page), and the four
// listeners this module attaches to `page.context()` do not survive past
// the call that attached them — proven by driving the *same* page/context
// through two calls and checking nothing is left listening afterward.
describe("experimental_recordStep: page", () => {
  let server: Server;
  let url: string;
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    ({ server, url } = await startPageServer());
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext({ baseURL: url });
  });

  afterEach(async () => {
    await requestContext.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  function stepRecordDir(recordId: string): string {
    return path.join(rootDir, ".nukadoko", "records", "steps", recordId);
  }

  it.skipIf(!chromiumAvailable)(
    "passes the exact injected page to the step's own run(), with no trace/screenshot on the record",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        let capturedPage: unknown;
        const identityStep = defineStep({
          description: "captures the page it was given, to prove it is the same object",
          args: z.object({}),
          returns: z.object({}),
          async run({ page: injectedPage }) {
            capturedPage = injectedPage;
            return {};
          },
        });

        const { stepRecordId } = await experimental_recordStep(identityStep, {}, {
          name: "capture-page",
          rootDir,
          request: requestContext,
          page,
        });

        // Reference equality, not merely "a Page" — proves `page.run()`
        // received this exact object, not a fresh one this module launched
        // for itself.
        expect(capturedPage).toBe(page);

        const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
        // No trace/screenshot: this module never opens either for a page it
        // did not launch itself (src/context/browser-evidence.ts's own
        // header) — the calling Playwright Test spec already owns both for
        // this exact page.
        expect(record.evidence.trace).toBeUndefined();
        expect(record.evidence.screenshots).toEqual([]);
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "counts page-issued traffic in observed, the same tally ctx.page() already keeps for a launched browser",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const gotoStep = defineStep({
          description: "navigates the injected page",
          args: z.object({}),
          returns: z.object({}),
          async run({ page }) {
            await page.goto(url);
            return {};
          },
        });

        const { stepRecordId } = await experimental_recordStep(gotoStep, {}, {
          name: "goto-page",
          rootDir,
          request: requestContext,
          page,
        });

        const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
        expect(record.observed).toEqual({ http_reads: 1, http_writes: 0 });
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "removes its own listeners after each call: recording twice through the same page leaves none behind on the caller's own context",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      // `BrowserContext#listenerCount` is a real, working method (it is a
      // Node `EventEmitter` under the hood) that Playwright's own .d.ts does
      // not type — this is the direct, spec-recommended way to prove a
      // listener this module attached did not outlive the call that
      // attached it: a leak would make this number keep growing across
      // calls instead of returning to 0 once each call's own dispose() ran.
      const listenerCount = (event: string): number =>
        (context as unknown as { listenerCount(event: string): number }).listenerCount(event);
      try {
        const gotoStep = defineStep({
          description: "navigates the injected page",
          args: z.object({}),
          returns: z.object({}),
          async run({ page }) {
            await page.goto(url);
            return {};
          },
        });

        await experimental_recordStep(gotoStep, {}, {
          name: "goto-page-1",
          rootDir,
          request: requestContext,
          page,
        });
        await experimental_recordStep(gotoStep, {}, {
          name: "goto-page-2",
          rootDir,
          request: requestContext,
          page,
        });

        // Every one of the four events browser-evidence.ts's
        // `attachExternalPageEvidence` subscribes must be back to 0 — a
        // leftover from either call would show up here, on the same
        // context both calls (and this test) share.
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

  it.skipIf(!chromiumAvailable)(
    "no longer refuses a step needing page once options.page is given (still refused without one, per the describe block above)",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const needsPageStep = defineStep({
          description: "needs a browser page, now supported when options.page is given",
          args: z.object({}),
          returns: z.object({}),
          async run({ page }) {
            await page.title();
            return {};
          },
        });

        await expect(
          experimental_recordStep(needsPageStep, {}, {
            name: "needs-page",
            rootDir,
            request: requestContext,
            page,
          }),
        ).resolves.toMatchObject({ result: {} });
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );

  if (!chromiumAvailable) {
    // Warns rather than silently skipping: only skip when chromium is
    // genuinely unavailable in this environment (this file's own
    // `isChromiumAvailable`).
    console.warn("external-record-step.test.ts: chromium unavailable, options.page adoption tests skipped");
  }
});

describe("experimental_recordStep: use", () => {
  // The mechanical points `use` itself is responsible for — `nuka do
  // --use`'s own meaning, reached through the same src/cli/resolve-use.ts
  // function (src/external/record-step.ts's own header). The heavier claim
  // this option exists for (a harvested draft built from a `use`-chained
  // execution stays green across a swapped backend) is
  // tests/external-use-run.test.ts's own job, not this file's — that one
  // needs a `from`-declaring on-disk step twin this fixture's single step
  // doesn't have.

  let server: Server;
  let url: string;
  let rootDir: string;
  let requestContext: APIRequestContext;

  const addItemArgs = z.object({ cartId: z.string() });
  const addItemReturns = z.object({ cartId: z.string() });

  function makeAddItemStep() {
    return defineStep({
      pattern: "an item is added",
      description: "Add an item to the open cart (no real HTTP call: this file's own point is `use`'s bookkeeping, not the transport)",
      args: addItemArgs,
      returns: addItemReturns,
      mutates: true,
      from: { cartId: [openCartStep, "id"] },
      run({}, { cartId }) {
        return { cartId };
      },
    });
  }

  beforeEach(async () => {
    ({ server, url } = await startCartServer());
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext({ baseURL: url });
  });

  afterEach(async () => {
    await requestContext.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  function stepRecordDir(recordId: string): string {
    return path.join(rootDir, ".nukadoko", "records", "steps", recordId);
  }

  it("fills a `from` key from a previous call's own step record, and records it in `used`", async () => {
    const opened = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const added = await experimental_recordStep(makeAddItemStep(), {}, {
      name: "add-item",
      rootDir,
      request: requestContext,
      use: [opened.stepRecordId],
    });

    expect(added.result).toEqual({ cartId: opened.result.id });

    const record = readStepRecord(stepRecordDir(added.stepRecordId)) as StepRecord;
    expect(record.args).toEqual({ cartId: opened.result.id });
    // Same shape a scenario's own `from` injection leaves (tests/from-
    // chain.test.ts): `{ step_record_id, step }`, no `result` — `nuka
    // harvest`'s own name match (src/harvest/categorize-args.ts) only ever
    // needs the step name, not the value again.
    expect(record.used).toEqual([{ step_record_id: opened.stepRecordId, step: "open-cart" }]);
  });

  it("an explicit args key wins over use for that same key — same priority nuka do --use gives --args", async () => {
    const opened = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const added = await experimental_recordStep(
      makeAddItemStep(),
      { cartId: "explicit-cart-id" },
      { name: "add-item", rootDir, request: requestContext, use: [opened.stepRecordId] },
    );

    expect(added.result).toEqual({ cartId: "explicit-cart-id" });

    const record = readStepRecord(stepRecordDir(added.stepRecordId)) as StepRecord;
    expect(record.args).toEqual({ cartId: "explicit-cart-id" });
    // `use` never actually filled anything here (its own candidate key was
    // already set by `args`), so nothing is cited — same "no injection
    // means no used entry" rule tests/from-chain.test.ts already covers for
    // a scenario's own `from`.
    expect(record.used).toBeUndefined();
  });

  it("an unknown use id is refused before any step record is written for this call", async () => {
    const before = existsSync(path.join(rootDir, ".nukadoko", "records", "steps"))
      ? readdirSync(path.join(rootDir, ".nukadoko", "records", "steps"))
      : [];

    await expect(
      experimental_recordStep(makeAddItemStep(), { cartId: "x" }, {
        name: "add-item",
        rootDir,
        request: requestContext,
        use: ["no-such-record"],
      }),
    ).rejects.toThrow(/no such step record/);

    const after = existsSync(path.join(rootDir, ".nukadoko", "records", "steps"))
      ? readdirSync(path.join(rootDir, ".nukadoko", "records", "steps"))
      : [];
    expect(after).toEqual(before);
  });
});
