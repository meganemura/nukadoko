import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: what each page of each browser context had received
// from the world around a reading (src/context/page-order.ts), measured
// through a step context with a world URL and a real Chromium: a page
// per context, the boundary each request was sent in, and a response the
// program holds back.

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

const ROOM = `<p id="state">loading</p><script>
  window.draw = (query) => fetch("/state" + query).then((r) => r.text()).then((t) => { document.getElementById("state").textContent = t; });
  draw("?n=load");
</script>`;

describe.skipIf(!chromiumAvailable)("what the pages had received around a reading", () => {
  let evidenceDir: string;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-page-order-"));
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/room") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(ROOM);
        return;
      }
      const hold = Number(url.searchParams.get("hold") ?? 0);
      setTimeout(() => res.end(url.searchParams.get("n") ?? "held"), hold);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("names, for each page of each context, the latest response it finished receiving, the requests in flight, and the boundary each was sent in", async () => {
    const handle = createStepContext({ config: config(), baseURL: origin, evidenceDir, env: {}, stepTitle: "page step" });
    const opens = { step_record_id: "step-opens", step: "aki-opens-the-room", line: 4 };
    try {
      await handle.beginStep(path.join(evidenceDir, "one"), "one", undefined, { kind: "step", step: opens });
      const aki = await handle.ctx.page();
      await aki.goto("/room");
      await aki.waitForFunction('document.getElementById("state").textContent === "load"');
      const first = handle.beginPageReading().end();

      await handle.beginStep(path.join(evidenceDir, "hook"), "hook", "hook.zip", { kind: "hook" });
      await aki.evaluate('draw("?n=hook")');
      await aki.waitForFunction('document.getElementById("state").textContent === "hook"');

      await handle.beginStep(path.join(evidenceDir, "two"), "two", undefined, { kind: "step", step: { step_record_id: "step-then", step: "the-room-shows", line: 5 } });
      const ben = await handle.ctx.pageAs("ben");
      await ben.goto("/room");
      await ben.waitForFunction('document.getElementById("state").textContent === "load"');
      const reading = handle.beginPageReading();
      await Promise.all([aki.waitForRequest(/hold=/), aki.evaluate('void draw("?hold=2000")')]);
      const found = reading.end();

      expect(found.map((page) => ({ as: page.as, page: page.page, url: page.url, last: page.last?.url, inFlight: page.inFlight.map((request) => request.url) }))).toEqual([
        { as: null, page: 1, url: `${origin}/room`, last: `${origin}/state?n=hook`, inFlight: [`${origin}/state?hold=2000`] },
        { as: "ben", page: 1, url: `${origin}/room`, last: `${origin}/state?n=load`, inFlight: [] },
      ]);
      const [loaded, hooked, held, bens] = await handle.pageRequestRecords([first[0]!.last!, found[0]!.last!, found[0]!.inFlight[0]!, found[1]!.last!]);
      expect(loaded).toEqual({
        method: "GET",
        url: `${origin}/state?n=load`,
        trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
        sent_at: expect.any(String),
        finished_at: expect.any(String),
        sent_during: "earlier-step",
        step: opens,
      });
      expect(Date.parse(loaded!.finished_at!)).toBeGreaterThanOrEqual(Date.parse(loaded!.sent_at));
      expect(hooked?.sent_during).toBe("hook");
      expect(hooked?.trace_id).not.toBe(loaded?.trace_id);
      expect([hooked?.span_id, bens?.span_id]).not.toContain(loaded?.span_id);
      expect(bens?.sent_during).toBe("this-step");
      // Still in flight when the record is made: no ids, no finish.
      expect(held).toEqual({ method: "GET", url: `${origin}/state?hold=2000`, sent_at: expect.any(String), finished_at: null, sent_during: "this-step" });
    } finally {
      await handle.dispose();
    }
  });

  it("finds no page before a browser launched", () => {
    const handle = createStepContext({ config: config(), baseURL: origin, evidenceDir, env: {}, stepTitle: "no page" });
    expect(handle.beginPageReading().end()).toEqual([]);
  });
});
