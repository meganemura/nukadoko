import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext } from "playwright";
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
// `page`/`context`-needing step is refused before any record exists,
// pinning the "no trace, no screenshot" rule this experimental surface
// promises (its own header, src/external/record-step.ts).
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
