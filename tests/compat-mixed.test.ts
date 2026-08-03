import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2b-compat-execution task spec's mixed-scenario coverage
// — a typed step and a compat step sharing one pickle's ctx (a cookie the
// compat step picks up via `this.openRequest()` is visible to a typed
// step's own `ctx.request()`), and a typed step's `ctx.resultOf` working
// normally even though the same scenario also has a compat step in it.

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

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("nuka run: typed and compat steps sharing one pickle's context", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("compat-mixed-project");
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

  it("a compat step's cookie (via this.openRequest()) is visible to a later typed step's ctx.request(), and ctx.resultOf still works", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/mixed.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");

    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(4);
    for (const step of record.steps) {
      expect(step.status).toBe("passed");
    }

    // ctx.resultOf, unaffected by the compat step sharing the same pickle.
    const createReceiptId = record.steps[0].receipt as string;
    const resultOfReceipt = await readReceipt(rootDir, record.steps[1].receipt);
    expect(resultOfReceipt.result).toEqual({ ok: true });
    expect(resultOfReceipt.used).toEqual([createReceiptId]);

    // The compat step's own receipt: openRequest() + a GET is measured
    // (observed), same as a typed step's ctx.request() would be.
    const compatReceipt = await readReceipt(rootDir, record.steps[2].receipt);
    expect(compatReceipt.result).toBeNull();
    expect((compatReceipt as { observed: { http_reads: number } }).observed.http_reads).toBe(1);

    // The typed step's own request context sees the compat step's cookie —
    // proof the two share one underlying Playwright APIRequestContext.
    const typedReceipt = await readReceipt(rootDir, record.steps[3].receipt);
    expect((typedReceipt as { result: { cookie: string } }).result.cookie).toContain("sid=abc123");
  });
});
