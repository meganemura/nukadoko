import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarvest } from "../src/cli/harvest.js";
import { runCli } from "../src/cli/run-cli.js";
import { recordStep } from "../src/external/record-step.js";
import type { StepRecord } from "../src/record/types.js";
import { defineStep } from "../src/step/define-step.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the claim src/external/record-step.ts's own header makes
// for `use` — a chained `recordStep` call leaves `nuka
// harvest` real evidence of the chain, so the draft it writes never bakes
// in one call's own id-of-the-moment, so the finished feature stays green
// after the backend that minted that id is gone. tests/external-record-
// step.test.ts already covers `use`'s own mechanics (fills `used`, `args`
// wins, a bad id is refused); this file only covers the round trip that
// mechanics alone can't prove — draft text, then two real `nuka run`
// executions against two independent backends.
//
// Needs a `from`-declaring on-disk step twin (tests/fixtures/external-use-
// project), unlike tests/external-record-step.test.ts's own fixture (a
// single step, no `from`) — `nuka harvest`'s own name match
// (src/harvest/categorize-args.ts) reads that declaration from a fresh
// discovery pass over the project the harvested feature actually runs
// against.

const openCartReturns = z.object({ id: z.string() });

const openCartStep = defineStep({
  pattern: "a cart is opened",
  description: "Open a new cart",
  args: z.object({}),
  returns: openCartReturns,
  mutates: true,
  async run({ request, requireEnv }) {
    const token = requireEnv("API_TOKEN");
    const res = await request.post(`/carts?token=${token}`);
    return openCartReturns.parse(await res.json());
  },
});

const addItemStep = defineStep({
  pattern: "an item is added",
  description: "Add an item to the open cart",
  args: z.object({ cartId: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  from: { cartId: [openCartStep, "id"] },
  async run({ request }, { cartId }) {
    const res = await request.post(`/carts/${cartId}/items`);
    if (!res.ok()) {
      throw new Error(`add-item: server rejected cart "${cartId}" (status ${res.status()})`);
    }
    return { ok: true };
  },
});

/**
 * One cart backend, independent open-cart-id state per instance — a fresh
 * call to this function is what "swap the server" means below: its own
 * counter starts back at 1, the same as the *first* server's did, which is
 * exactly the condition that would expose a literal baked into the draft
 * (this file's own header).
 */
function startCartServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    let counter = 0;
    const openCartIds = new Set<string>();
    const server = createServer((req, res) => {
      const itemsMatch = req.method === "POST" ? req.url?.match(/^\/carts\/([^/?]+)\/items$/) : null;
      if (itemsMatch) {
        const cartId = itemsMatch[1]!;
        if (!openCartIds.has(cartId)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/carts?")) {
        counter += 1;
        const id = `cart-${counter}`;
        openCartIds.add(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
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

function configSource(baseURL: string): string {
  return [
    'import { defineConfig } from "./nukadoko-shim.js";',
    `export default defineConfig({ baseURL: "${baseURL}", envFiles: [".env.secret"] });`,
    "",
  ].join("\n");
}

function firstScenarioRecord(stdout: string): { status: string } {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return JSON.parse(line ?? "{}") as { status: string };
}

describe("recordStep use: a chained draft survives a swapped backend", () => {
  let server: Server;
  let url: string;
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    ({ server, url } = await startCartServer());
    rootDir = await copyFixtureToTempDir("external-use-project");
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), configSource(url));
    requestContext = await playwrightRequest.newContext({ baseURL: url });
  });

  afterEach(async () => {
    await requestContext.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("harvests a use-chained execution with no baked-in literal, and the finished feature runs green before and after the backend is swapped", async () => {
    // A warm-up cart, outside any step record, so the recorded cart id is
    // not "cart-1" — a fresh backend's own first cart would also be
    // "cart-1", which would hide a regression to the literal-baking bug
    // this test exists to catch (this file's own header).
    await requestContext.post("/carts?token=warmup");

    const opened = await recordStep(
      openCartStep,
      {},
      { name: "open-cart", rootDir, request: requestContext },
    );
    const added = await recordStep(addItemStep, {}, {
      name: "add-item",
      rootDir,
      request: requestContext,
      use: [opened.stepRecordId],
    });
    expect(opened.result.id).not.toBe("cart-1");
    expect(added.result).toEqual({ ok: true });

    // Criterion 1: `use` leaves `used` on the record it filled.
    const addedRecordPath = path.join(
      rootDir,
      ".nukadoko",
      "records",
      "steps",
      added.stepRecordId,
      "record.json",
    );
    const addedRecord = JSON.parse(await readFile(addedRecordPath, "utf8")) as StepRecord;
    expect(addedRecord.used).toEqual([{ step_record_id: opened.stepRecordId, step: "open-cart" }]);

    // Criterion 2: harvesting the chain never renders `cartId` as a literal
    // — no docstring/table carries the recorded cart id anywhere in the
    // draft.
    const harvestStdout = createCaptureSink();
    const harvestExit = await runHarvest({
      rootDir,
      stepRecordIds: [opened.stepRecordId, added.stepRecordId],
      stdout: harvestStdout,
      stderr: createCaptureSink(),
    });
    expect(harvestExit).toBe(0);
    const draft = harvestStdout.text();
    expect(draft).not.toContain(opened.result.id);
    expect(draft).toContain("a cart is opened");
    expect(draft).toContain("an item is added");

    const finishedFeature = draft
      .replace("Feature: (name me)", "Feature: Shopping cart")
      .replace("Scenario: (name me)", "Scenario: Add an item to a fresh cart");
    await writeFile(path.join(rootDir, "features", "cart.feature"), finishedFeature);

    // Criterion 3, part one: the finished draft runs green against the
    // backend it was recorded against.
    const runStdout1 = createCaptureSink();
    const runExit1 = await runCli(["run", "features/cart.feature"], {
      rootDir,
      stdout: runStdout1,
      stderr: createCaptureSink(),
    });
    expect(runExit1).toBe(0);
    expect(firstScenarioRecord(runStdout1.text()).status).toBe("passed");

    // Criterion 3, part two — the point of this fix: swap the backend for a
    // fresh one (its own cart id counter starts over, so it mints the same
    // literal "cart-1" a regression would have baked into the draft) and
    // the same finished feature still runs green. A second project
    // directory, not a config rewrite in place, so no stale config import
    // can mask the swap.
    const { server: server2, url: url2 } = await startCartServer();
    try {
      const rootDir2 = await copyFixtureToTempDir("external-use-project");
      try {
        await writeFile(path.join(rootDir2, "nukadoko.config.ts"), configSource(url2));
        await writeFile(path.join(rootDir2, "features", "cart.feature"), finishedFeature);

        const runStdout2 = createCaptureSink();
        const runExit2 = await runCli(["run", "features/cart.feature"], {
          rootDir: rootDir2,
          stdout: runStdout2,
          stderr: createCaptureSink(),
        });
        expect(runExit2).toBe(0);
        expect(firstScenarioRecord(runStdout2.text()).status).toBe("passed");
      } finally {
        await removeTempDir(rootDir2);
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
