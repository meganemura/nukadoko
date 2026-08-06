import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: the Background + browser round trip this task's spec asks
// for, rewritten for p3a-trace-per-step (trace is now per-step, not per-
// scenario) — a Background step opens the browser and picks up a cookie,
// the scenario's own step reuses the *same* browser context to see it (this
// task's spec, decision "Steps in one pickle share one context"), and each
// step's own trace.zip now lands in *that step's own* receipt dir, carrying
// only that step's own operations (p3a-trace-per-step task spec, completion
// condition 2) — the scenario record itself carries no trace of its own any
// more (completion condition: "シナリオ全体の1本は無くなった"). A second
// scenario in the same feature file (a step that never calls `ctx.page()`,
// run right after the Background already launched the browser for an
// earlier scenario in this same `nuka run` invocation) proves completion
// condition 6: that step's own receipt carries no `evidence.trace` at all.

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/set-cookie") {
        res.writeHead(200, {
          "set-cookie": "sid=abc123; Path=/",
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

interface StoredReceipt {
  status: string;
  kind: string;
  scenario: string;
  evidence: { dir: string; trace?: string; screenshots: unknown[] };
  actions?: Array<{ method: string; url?: string; selector?: string; ms: number; outcome: string; at: string }>;
  result: { ok?: boolean; cookie?: string | null };
}

async function readReceipt(rootDir: string, receiptId: string): Promise<StoredReceipt> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8")) as StoredReceipt;
}

describe("nuka run (Background + browser)", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("run-browser-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}" });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("shares one browser context across a Background step and the scenario's own step, each with its own trace", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/browser-scenario.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const [record, noBrowserRecord] = lines.map((line) => JSON.parse(line));

    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("passed");

    // The scenario-long trace is gone (p3a-trace-per-step task spec): no
    // single file spans the whole scenario any more, only the scenario's
    // own final screenshot does.
    expect(record.evidence.trace).toBeUndefined();
    expect(record.evidence.screenshots).toHaveLength(1);
    expect(record.evidence.screenshots[0].file).toBe("final.png");
    expect(Number.isNaN(Date.parse(record.evidence.screenshots[0].at))).toBe(false);
    const scenarioDir = path.join(rootDir, record.evidence.dir);
    expect(existsSync(path.join(scenarioDir, "trace.zip"))).toBe(false);
    expect(existsSync(path.join(scenarioDir, "final.png"))).toBe(true);

    // Each step carries its own trace.zip instead — completion condition 2:
    // a 2-step scenario produces 2 trace files, each holding only that
    // step's own operations.
    const loginReceipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const whoamiReceipt = await readReceipt(rootDir, record.steps[1].receipt as string);

    for (const receipt of [loginReceipt, whoamiReceipt]) {
      expect(receipt.evidence.trace).toBe("trace.zip");
      expect(receipt.evidence.screenshots).toEqual([]);
      expect(receipt.kind).toBe("run");
      expect(receipt.scenario).toBe(record.scenario_id);
      const receiptDir = path.join(rootDir, receipt.evidence.dir);
      expect(existsSync(path.join(receiptDir, "trace.zip"))).toBe(true);
    }
    // Different files, not the same one referenced twice.
    expect(loginReceipt.evidence.dir).not.toBe(whoamiReceipt.evidence.dir);

    // The split is real, not just two file names: each step's own `actions`
    // (read out of that step's own trace chunk) shows only the URL *that*
    // step navigated to, never the other step's.
    const loginUrls = (loginReceipt.actions ?? []).map((action) => action.url).filter(Boolean);
    const whoamiUrls = (whoamiReceipt.actions ?? []).map((action) => action.url).filter(Boolean);
    expect(loginUrls.some((url) => url?.includes("/set-cookie"))).toBe(true);
    expect(loginUrls.some((url) => url?.includes("/whoami"))).toBe(false);
    expect(whoamiUrls.some((url) => url?.includes("/whoami"))).toBe(true);
    expect(whoamiUrls.some((url) => url?.includes("/set-cookie"))).toBe(false);

    // The whoami step's own receipt proves the *same* browser context (and
    // therefore the same cookie jar) as the Background step's.
    expect(whoamiReceipt.result.cookie).toContain("sid=abc123");

    // Second scenario: its own Background step still runs (and still gets a
    // trace, launching a brand new browser for this new scenario's own
    // ctx), but the scenario's *own* step after it never calls `ctx.page()`
    // at all and must carry no trace of its own (completion condition 6) —
    // proving the trace chunk is opened lazily per step, never just because
    // a browser already happens to be running.
    expect(noBrowserRecord.status).toBe("passed");
    expect(noBrowserRecord.steps).toHaveLength(2);
    const secondBackgroundReceipt = await readReceipt(rootDir, noBrowserRecord.steps[0].receipt as string);
    expect(secondBackgroundReceipt.evidence.trace).toBe("trace.zip");

    const noBrowserReceipt = await readReceipt(rootDir, noBrowserRecord.steps[1].receipt as string);
    expect(noBrowserReceipt.evidence.trace).toBeUndefined();
    expect(Object.keys(noBrowserReceipt.evidence)).not.toContain("trace");
    expect(noBrowserReceipt.actions).toBeUndefined();
    const noBrowserReceiptDir = path.join(rootDir, noBrowserReceipt.evidence.dir);
    expect(existsSync(path.join(noBrowserReceiptDir, "trace.zip"))).toBe(false);
  });
});
