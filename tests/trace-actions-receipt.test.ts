import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `actions` end to end against tests/fixtures/
// trace-actions-project (p3a-trace-per-step task spec) — a real chromium
// `page.goto()` to a URL whose query string carries a secret, proving
// completion condition 5 ("シークレットを含む URL を踏んだとき、actions にも
// 生値が出ないこと") for both `nuka run` and `nuka do`: `actions` is built
// from the step's own trace chunk and folded onto the receipt object
// *before* the one existing `redact()` call each executor already makes
// (cli/do.ts, run-scenario.ts), so no separate redaction path was added for
// it — this test is what pins that down, the same way
// tests/page-events-receipt.test.ts already does for `page_events`.

const URL_TOKEN = "sekrit-url-token-789";

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${req.url}</body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

interface StoredReceipt {
  status: string;
  actions?: Array<{ method: string; url?: string }>;
}

describe("actions on the receipt: secret redaction", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("trace-actions-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}", envFiles: [".env.secret"] });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("nuka do: the goto action's own url is redacted, never the raw secret", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "visit-secret-url", "--args", "{}"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const receipt = JSON.parse(stdout.text()) as StoredReceipt & { evidence: { dir: string } };
    expect(receipt.status).toBe("ok");

    const gotoAction = (receipt.actions ?? []).find((action) => action.method === "goto");
    expect(gotoAction).toBeDefined();
    expect(gotoAction?.url).toContain("{{secret.URL_TOKEN}}");
    expect(gotoAction?.url).not.toContain(URL_TOKEN);

    // Same three-exits check tests/page-events-receipt.test.ts already runs
    // for page_events: the raw token must appear nowhere, not in stdout, not
    // in receipt.json on disk.
    expect(stdout.text()).not.toContain(URL_TOKEN);
    const receiptPath = path.join(rootDir, receipt.evidence.dir, "receipt.json");
    const receiptText = await readFile(receiptPath, "utf8");
    expect(receiptText).not.toContain(URL_TOKEN);
    expect(receiptText).toContain("{{secret.URL_TOKEN}}");
  });

  it("nuka run: the goto action's own url is redacted on the step's own receipt", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/visit-secret-url.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe("passed");

    const receiptPath = path.join(
      rootDir,
      ".nukadoko",
      "receipts",
      record.steps[0].receipt as string,
      "receipt.json",
    );
    const receiptText = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as StoredReceipt;
    expect(receipt.status).toBe("ok");

    const gotoAction = (receipt.actions ?? []).find((action) => action.method === "goto");
    expect(gotoAction).toBeDefined();
    expect(gotoAction?.url).toContain("{{secret.URL_TOKEN}}");
    expect(gotoAction?.url).not.toContain(URL_TOKEN);
    expect(receiptText).not.toContain(URL_TOKEN);
  });
});
