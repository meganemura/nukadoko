import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, request as playwrightRequest, type APIRequestContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it.skipIf(!chromiumAvailable)(
    "counts a console error, an uncaught page error, and a failed request into page_events, the same way ctx.page() already does",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const pageEventsStep = defineStep({
          description: "trips a console error, an uncaught error, and a failed request on the injected page",
          args: z.object({}),
          returns: z.object({ ok: z.boolean() }),
          async run({ page }) {
            const pageContext = page.context();
            // Awaited before the assertion below, the same technique
            // tests/fixtures/page-events-project's own trigger-page-events.ts
            // fixture uses: PageEventsCollector's own listener is registered
            // at context creation, well before this handler runs, so by the
            // time each of these promises resolves, the collector's own has
            // already run in the same tick.
            const consoleErrorSeen = pageContext.waitForEvent("console", {
              predicate: (msg) => msg.type() === "error",
              timeout: 10_000,
            });
            const webErrorSeen = pageContext.waitForEvent("weberror", { timeout: 10_000 });
            const requestFailedSeen = pageContext.waitForEvent("requestfailed", { timeout: 10_000 });

            await page.setContent(
              `<script>console.error("console error");</script>` +
                `<script>throw new Error("uncaught error");</script>`,
            );
            await page.evaluate(async () => {
              try {
                await fetch("http://127.0.0.1:1/unreachable");
              } catch {
                // Expected: nothing listens on this port. The context's own
                // requestfailed event, awaited below, is what this exists to
                // trigger.
              }
            });

            await Promise.all([consoleErrorSeen, webErrorSeen, requestFailedSeen]);
            return { ok: true };
          },
        });

        const { stepRecordId } = await experimental_recordStep(pageEventsStep, {}, {
          name: "page-events-step",
          rootDir,
          request: requestContext,
          page,
        });

        const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
        // At least the explicit console.error() call above — Chromium also
        // auto-logs an uncaught exception as a console error of its own, so
        // this is >= 1, not exactly 1 (same fact tests/page-events-step-
        // record.test.ts's own assertion is built around).
        expect(record.page_events?.console_errors?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(record.page_events?.console_errors?.some((entry) => entry.text === "console error")).toBe(true);
        expect(record.page_events?.page_errors).toHaveLength(1);
        expect(record.page_events?.page_errors?.[0]?.message).toBe("uncaught error");
        expect(record.page_events?.failed_requests).toHaveLength(1);
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "swallows a dispose() failure on the adopted page's own listener removal, and still writes the record it already had",
    async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      const offSpy = vi.spyOn(context, "off").mockImplementation(() => {
        throw new Error("boom from off()");
      });
      try {
        const simpleStep = defineStep({
          description: "a trivial step, to exercise dispose() failing on an adopted page",
          args: z.object({}),
          returns: z.object({}),
          async run({ page }) {
            await page.title();
            return {};
          },
        });

        const { stepRecordId } = await experimental_recordStep(simpleStep, {}, {
          name: "dispose-throws",
          rootDir,
          request: requestContext,
          page,
        });

        const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
        // The step itself still succeeded (dispose() runs after the result
        // is already settled) — only the evidence this backstop provides
        // defaults, per create-context.ts's own "no evidence file is known
        // to exist in that case" fallback.
        expect(record.status).toBe("ok");
        expect(record.evidence.screenshots).toEqual([]);
        expect(record.evidence.trace).toBeUndefined();
      } finally {
        offSpy.mockRestore();
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

  // A second candidate producer for `cartId`, distinct from `openCartStep` —
  // exists only so a key can have two candidates, needed to exercise the
  // "two `use` ids disagree about which candidate producer fills the same
  // key" refusal below (`from`'s multi-candidate form, docs/spec.md
  // "Chaining steps").
  const importCartArgs = z.object({});
  const importCartReturns = z.object({ cartId: z.string() });
  const importCartStep = defineStep({
    pattern: "a cart is imported",
    description: "Import an existing cart, as a second candidate producer of cartId",
    args: importCartArgs,
    returns: importCartReturns,
    mutates: true,
    async run({ request }) {
      const res = await request.post("/carts");
      const body = await res.json();
      return { cartId: body.id };
    },
  });

  function makeAddItemMultiCandidateStep() {
    return defineStep({
      description: "Add an item, accepting cartId from either candidate producer",
      args: z.object({ cartId: z.string() }),
      returns: z.object({ cartId: z.string() }),
      mutates: true,
      from: { cartId: [[openCartStep, "id"], [importCartStep, "cartId"]] },
      run({}, { cartId }) {
        return { cartId };
      },
    });
  }

  function bareStepsDir(): string {
    return path.join(rootDir, ".nukadoko", "records", "steps");
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

  it("two use ids that fill the same key from two different candidate producers are refused, before any step record is written for this call", async () => {
    const opened = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const imported = await experimental_recordStep(
      importCartStep,
      {},
      { name: "import-cart", rootDir, request: requestContext },
    );
    const before = readdirSync(bareStepsDir());

    await expect(
      experimental_recordStep(makeAddItemMultiCandidateStep(), {}, {
        name: "add-item-multi",
        rootDir,
        request: requestContext,
        use: [opened.stepRecordId, imported.stepRecordId],
      }),
    ).rejects.toThrow(/cannot tell which one should win/);

    // Neither `use` id ambiguity, nor the call that raised it, wrote a
    // step record for this call — same "checked before anything is
    // written" rule the unknown-id refusal above already follows.
    expect(readdirSync(bareStepsDir())).toEqual(before);
  });

  it("a returns-validation failure still writes a failed record carrying the use-filled args and the used entry", async () => {
    const opened = await experimental_recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const badReturnsStep = defineStep({
      description: "Fills cartId from use, then returns a shape its own schema rejects",
      args: addItemArgs,
      returns: z.object({ cartId: z.string(), itemCount: z.number() }),
      mutates: true,
      from: { cartId: [openCartStep, "id"] },
      run({}, { cartId }) {
        return { cartId } as any;
      },
    });

    const before = new Set(readdirSync(bareStepsDir()));
    await expect(
      experimental_recordStep(badReturnsStep, {}, {
        name: "add-item-bad-returns",
        rootDir,
        request: requestContext,
        use: [opened.stepRecordId],
      }),
    ).rejects.toThrow(/returns validation failed/);

    const newIds = readdirSync(bareStepsDir()).filter((id) => !before.has(id));
    expect(newIds).toHaveLength(1);
    const record = readStepRecord(stepRecordDir(newIds[0]!)) as StepRecord;
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("result_invalid");
    expect(record.args).toEqual({ cartId: opened.result.id });
    // Unlike an "ok" record's own `used` (stripped of `result` by
    // `omitUsedResults`, tested above), a failed record's `used` keeps the
    // full upstream result — `src/context/used.ts`'s own documented reason:
    // a failed step record can be read alone, with no second record.json
    // to open just to see what it read.
    expect(record.used).toEqual([
      { step_record_id: opened.stepRecordId, step: "open-cart", result: opened.result },
    ]);
  });
});

describe("experimental_recordStep: a malformed from entry", () => {
  // Same broken shape tests/from-malformed-entry.test.ts's own fixture
  // carries (a `Step` object cast into a `[step, key]` tuple's own type
  // instead of wrapped in one) — reached here through `step.from` directly
  // rather than through the on-disk fixture project, since this module's
  // own walk of `step.from` (src/external/record-step.ts) runs
  // unconditionally, before `options.use` is even read, so no `use` id is
  // needed to trigger it.

  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext();
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  it("names the broken from key in the thrown message, the same way nuka steps/describe do", async () => {
    const malformedFromStep = defineStep({
      description: "from names an upstream with the Step object itself, not a tuple",
      args: z.object({ cartId: z.string() }),
      returns: z.object({ ok: z.boolean() }),
      mutates: false,
      from: { cartId: openCartStep as unknown as [typeof openCartStep, "id"] },
      async run() {
        return { ok: true };
      },
    });

    await expect(
      experimental_recordStep(
        malformedFromStep,
        { cartId: "unused" },
        { name: "malformed-from", rootDir, request: requestContext },
      ),
    ).rejects.toThrow(/from\.cartId is not usable/);
  });
});

// Responsibility: the step_error path — `step.run` itself throwing, as
// distinct from an args/returns schema failure. Both the caught value's own
// message (an `Error`) and its `String(...)` fallback (a non-`Error` throw)
// are exercised, since the failed record's own `error.message` is built
// differently for each.
describe("experimental_recordStep: the step's own run() throws", () => {
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext();
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  function stepRecordDir(recordId: string): string {
    return path.join(rootDir, ".nukadoko", "records", "steps", recordId);
  }

  it("rethrows the step's own Error unchanged and writes a failed record with kind step_error", async () => {
    const boom = new Error("boom from the step");
    const throwingStep = defineStep({
      description: "Always throws an Error instance",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        throw boom;
      },
    });

    let thrown: unknown;
    try {
      await experimental_recordStep(throwingStep, {}, { name: "throwing-step", rootDir, request: requestContext });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);

    const [recordId] = readdirSync(path.join(rootDir, ".nukadoko", "records", "steps"));
    const record = readStepRecord(stepRecordDir(recordId!)) as StepRecord;
    expect(record.status === "failed" && record.error).toEqual({ kind: "step_error", message: "boom from the step" });
  });

  it("stringifies a non-Error thrown value into the failed record's own error message", async () => {
    const throwingStep = defineStep({
      description: "Throws a plain string, not an Error instance",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        throw "not an Error object";
      },
    });

    let thrown: unknown;
    try {
      await experimental_recordStep(throwingStep, {}, {
        name: "throwing-step-string",
        rootDir,
        request: requestContext,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe("not an Error object");

    const [recordId] = readdirSync(path.join(rootDir, ".nukadoko", "records", "steps"));
    const record = readStepRecord(stepRecordDir(recordId!)) as StepRecord;
    expect(record.status === "failed" && record.error).toEqual({
      kind: "step_error",
      message: "not an Error object",
    });
  });
});

// Responsibility: `experimental_recordStep`'s own `stepNameOf` callback
// (passed to `createStepContext`, read by `ctx.call`'s own `partName`) —
// names the top-level step by `options.name` when `ctx.call` reports about
// it, and falls back to `create-context.ts`'s own generic wording for any
// other step, since this module only ever knows the discovered name of the
// one step it was called for.
describe("experimental_recordStep: ctx.call diagnostics name the caller by its own registered name", () => {
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext();
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  it("names the caller by its registered name, and the undeclared part by the generic 'never registered' wording, in one PartNotDeclaredError", async () => {
    const undeclaredPart = defineStep({
      description: "Never listed in the caller's own parts",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const callerStep = defineStep({
      description: "Calls a part it never declared in parts",
      args: z.object({}),
      returns: z.object({}),
      async run({ call }) {
        return call(undeclaredPart, {});
      },
    });

    await expect(
      experimental_recordStep(callerStep, {}, { name: "caller-step", rootDir, request: requestContext }),
    ).rejects.toThrow(/Step "caller-step" called "a step discovery never registered" through call\(\)/);
  });
});

// Responsibility: a failed execution still carries what it measured before
// failing — `experimental_recordStep`'s own snapshots (sections, calls,
// required_env) are taken unconditionally after `step.run` settles, not only
// on the success path, the same "measurement must never depend on the
// outcome" rule the ok-status record already follows.
describe("experimental_recordStep: a failed run still records what it measured before failing", () => {
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-project");
    requestContext = await playwrightRequest.newContext();
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  function stepRecordDir(recordId: string): string {
    return path.join(rootDir, ".nukadoko", "records", "steps", recordId);
  }

  it("carries sections, calls, and required_env onto a failed record when the failure only happens at the very end", async () => {
    const declaredPart = defineStep({
      description: "A declared part the composite step calls successfully before failing",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const compositeStep = defineStep({
      description: "Opens a section, calls a declared part, polls once, reads an env var, then fails its own returns schema",
      args: z.object({}),
      returns: z.object({ ok: z.boolean() }),
      parts: [declaredPart],
      async run({ section, call, poll, requireEnv }) {
        section("setup");
        await call(declaredPart, {});
        await poll(async () => "done");
        requireEnv("API_TOKEN");
        return {} as any;
      },
    });

    let thrown: unknown;
    try {
      await experimental_recordStep(compositeStep, {}, { name: "composite-step", rootDir, request: requestContext });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/returns validation failed/);

    const [recordId] = readdirSync(path.join(rootDir, ".nukadoko", "records", "steps"));
    const record = readStepRecord(stepRecordDir(recordId!)) as StepRecord;
    expect(record.status).toBe("failed");
    expect(record.sections?.[0]?.label).toBe("setup");
    expect(record.calls).toHaveLength(1);
    expect(record.polls).toHaveLength(1);
    expect(record.required_env).toEqual(["API_TOKEN"]);
  });

  it("carries sections, calls, polls, and required_env onto an ok record too — the same measurement, on the other status branch", async () => {
    const declaredPart = defineStep({
      description: "A declared part the composite step calls successfully",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const compositeStep = defineStep({
      description: "Opens a section, calls a declared part, polls once, reads an env var, then succeeds",
      args: z.object({}),
      returns: z.object({ ok: z.boolean() }),
      parts: [declaredPart],
      async run({ section, call, poll, requireEnv }) {
        section("setup");
        await call(declaredPart, {});
        await poll(async () => "done");
        requireEnv("API_TOKEN");
        return { ok: true };
      },
    });

    const { stepRecordId } = await experimental_recordStep(compositeStep, {}, {
      name: "composite-step-ok",
      rootDir,
      request: requestContext,
    });

    const record = readStepRecord(stepRecordDir(stepRecordId)) as StepRecord;
    expect(record.status).toBe("ok");
    expect(record.sections?.[0]?.label).toBe("setup");
    expect(record.calls).toHaveLength(1);
    expect(record.polls).toHaveLength(1);
    expect(record.required_env).toEqual(["API_TOKEN"]);
  });
});

// Responsibility: `config.envFiles ?? []` — a project whose config sets no
// `envFiles` at all still has to load and classify env files (the
// `loadEnvFiles`/`classifyEnvFiles` calls just below it). `envFiles` has no
// zod default (`z.array(z.string()).optional()`, src/config/schema.ts), so
// `undefined` is a real value this module has to fall back from, not merely
// a defensive guard against a value the schema already rules out.
describe("experimental_recordStep: a project with no envFiles at all", () => {
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-no-envfiles-project");
    requestContext = await playwrightRequest.newContext();
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  it("still runs and writes an ok record when config.envFiles is omitted", async () => {
    const trivialStep = defineStep({
      description: "A step with nothing to do, to exercise a config with no envFiles at all",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });

    const { result, stepRecordId } = await experimental_recordStep(trivialStep, {}, {
      name: "trivial-step",
      rootDir,
      request: requestContext,
    });
    expect(result).toEqual({});

    const record = readStepRecord(
      path.join(rootDir, ".nukadoko", "records", "steps", stepRecordId),
    ) as StepRecord;
    expect(record.status).toBe("ok");
  });
});
