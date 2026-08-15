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

// Responsibility: the Background + browser round trip, rewritten
// for p3a-trace-per-step (trace is now per-step, not per-
// scenario) — a Background step opens the browser and picks up a cookie,
// the scenario's own step reuses the *same* browser context to see it
// (steps in one pickle share one context), and each
// step's own trace.zip now lands in *that step's own* step record dir, carrying
// only that step's own operations — the scenario record itself carries no trace of its own any
// more (completion condition: "シナリオ全体の1本は無くなった"). A second
// scenario in the same feature file (a step that never calls `ctx.page()`,
// run right after the Background already launched the browser for an
// earlier scenario in this same `nuka run` invocation) proves completion
// condition 6: that step's own step record carries no `evidence.trace` at all.

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

interface StoredStepRecord {
  status: string;
  kind: string;
  scenario: string;
  evidence: { dir: string; trace?: string; screenshots: unknown[] };
  actions?: Array<{ method: string; url?: string; selector?: string; ms: number; outcome: string; at: string }>;
  result: { ok?: boolean; cookie?: string | null };
}

async function readStepRecord(rootDir: string, recordId: string): Promise<StoredStepRecord> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8")) as StoredStepRecord;
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

    // The scenario-long trace is gone: no
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
    const loginStepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    const whoamiStepRecord = await readStepRecord(rootDir, record.steps[1].record as string);

    for (const stepRecord of [loginStepRecord, whoamiStepRecord]) {
      expect(stepRecord.evidence.trace).toBe("trace.zip");
      expect(stepRecord.evidence.screenshots).toEqual([]);
      expect(stepRecord.kind).toBe("run");
      expect(stepRecord.scenario).toBe(record.scenario_id);
      const recordDir = path.join(rootDir, stepRecord.evidence.dir);
      expect(existsSync(path.join(recordDir, "trace.zip"))).toBe(true);
    }
    // Different files, not the same one referenced twice.
    expect(loginStepRecord.evidence.dir).not.toBe(whoamiStepRecord.evidence.dir);

    // The split is real, not just two file names: each step's own `actions`
    // (read out of that step's own trace chunk) shows only the URL *that*
    // step navigated to, never the other step's.
    const loginUrls = (loginStepRecord.actions ?? []).map((action) => action.url).filter(Boolean);
    const whoamiUrls = (whoamiStepRecord.actions ?? []).map((action) => action.url).filter(Boolean);
    expect(loginUrls.some((url) => url?.includes("/set-cookie"))).toBe(true);
    expect(loginUrls.some((url) => url?.includes("/whoami"))).toBe(false);
    expect(whoamiUrls.some((url) => url?.includes("/whoami"))).toBe(true);
    expect(whoamiUrls.some((url) => url?.includes("/set-cookie"))).toBe(false);

    // The whoami step's own step record proves the *same* browser context (and
    // therefore the same cookie jar) as the Background step's.
    expect(whoamiStepRecord.result.cookie).toContain("sid=abc123");

    // Second scenario: its own Background step still runs (and still gets a
    // trace, launching a brand new browser for this new scenario's own
    // ctx), but the scenario's *own* step after it never calls `ctx.page()`
    // at all and must carry no trace of its own (completion condition 6) —
    // proving the trace chunk is opened lazily per step, never just because
    // a browser already happens to be running.
    expect(noBrowserRecord.status).toBe("passed");
    expect(noBrowserRecord.steps).toHaveLength(2);
    const secondBackgroundStepRecord = await readStepRecord(rootDir, noBrowserRecord.steps[0].record as string);
    expect(secondBackgroundStepRecord.evidence.trace).toBe("trace.zip");

    const noBrowserStepRecord = await readStepRecord(rootDir, noBrowserRecord.steps[1].record as string);
    expect(noBrowserStepRecord.evidence.trace).toBeUndefined();
    expect(Object.keys(noBrowserStepRecord.evidence)).not.toContain("trace");
    expect(noBrowserStepRecord.actions).toBeUndefined();
    const noBrowserStepRecordDir = path.join(rootDir, noBrowserStepRecord.evidence.dir);
    expect(existsSync(path.join(noBrowserStepRecordDir, "trace.zip"))).toBe(false);
  });
});
