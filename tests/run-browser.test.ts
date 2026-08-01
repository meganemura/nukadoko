import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the one Background + browser round trip this task's spec
// asks for — a Background step opens the browser and picks up a cookie, and
// the scenario's own step reuses the *same* browser context to see it (this
// task's spec, decision "Steps in one pickle share one context"), and the
// scenario's trace.zip / final.png land in the scenario's own directory, not
// on either step's receipt (this task's spec, decision 5).

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

  it("shares one browser context across a Background step and the scenario's own step, with scenario-level trace/screenshot evidence", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/browser-scenario.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");

    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("passed");

    // Scenario-level browser evidence, not on either step's receipt.
    expect(record.evidence.trace).toBe("trace.zip");
    expect(record.evidence.screenshots).toContain("final.png");
    const scenarioDir = path.join(rootDir, record.evidence.dir);
    expect(existsSync(path.join(scenarioDir, "trace.zip"))).toBe(true);
    expect(existsSync(path.join(scenarioDir, "final.png"))).toBe(true);

    for (const step of record.steps) {
      const receiptPath = path.join(rootDir, ".nukadoko", "receipts", step.receipt, "receipt.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(receipt.evidence.trace).toBeUndefined();
      expect(receipt.evidence.screenshots).toEqual([]);
      expect(receipt.kind).toBe("run");
      expect(receipt.scenario).toBe(record.scenario_id);
    }

    // The whoami step's own receipt proves the *same* browser context
    // (and therefore the same cookie jar) as the Background step's.
    const whoamiReceiptPath = path.join(
      rootDir,
      ".nukadoko",
      "receipts",
      record.steps[1].receipt,
      "receipt.json",
    );
    const whoamiReceipt = JSON.parse(await readFile(whoamiReceiptPath, "utf8"));
    expect(whoamiReceipt.result.cookie).toContain("sid=abc123");
  });
});
