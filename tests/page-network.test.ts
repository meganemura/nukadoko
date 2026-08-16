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

// Responsibility: http.jsonl's page-origin half, end to end against
// tests/fixtures/page-network-project — a real
// chromium page pulling in an image, a stylesheet, and a script (dropped,
// tallied into the step record's own `http_omitted`) alongside its own document
// response and an in-page `fetch` carrying a secret (both kept, `via:
// "page"`), next to one `ctx.request()` call (`via: "request"`) hitting the
// same `/api/data` path with a different query string — proving neither
// path double-counts the other's own call
// and that `observed` keeps counting every request regardless of what
// http.jsonl went on to keep (scope item 2). Redaction is proven the same
// way tests/trace-actions-step-record.test.ts already proves it for `actions`:
// a secret embedded in the page-issued fetch's own query string.

const API_TOKEN = "sekrit-network-token-789";

// 1x1 transparent GIF — Playwright classifies a resourceType by how a
// resource was requested (an `<img>` tag), not by validating its bytes, so
// this only needs to be small and harmless, not a real image.
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

interface StoredStepRecord {
  status: string;
  evidence: { dir: string; http?: string };
  observed: { http_reads: number; http_writes: number };
  http_omitted?: Record<string, number>;
}

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<html><head><link rel="stylesheet" href="/style.css">' +
            '<script src="/app.js"></script></head>' +
            '<body><img src="/pixel.gif"></body></html>',
        );
        return;
      }
      if (url === "/clean") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>clean</body></html>");
        return;
      }
      if (url === "/pixel.gif") {
        res.writeHead(200, { "content-type": "image/gif" });
        res.end(PIXEL_GIF);
        return;
      }
      if (url === "/style.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { color: red; }");
        return;
      }
      if (url === "/app.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("// noop");
        return;
      }
      if (url.startsWith("/api/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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

async function readStepRecord(rootDir: string, recordId: string): Promise<StoredStepRecord> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8")) as StoredStepRecord;
}

async function readHttpJsonl(
  rootDir: string,
  evidenceDir: string,
): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(rootDir, evidenceDir, "http.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("page-issued traffic on http.jsonl and http_omitted", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("page-network-project");
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

  it("nuka do: page traffic is via: page, ctx.request() traffic is via: request, assets are omitted not duplicated, secrets are redacted, and observed is not narrowed", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "browse-page", "--args", "{}"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const stepRecord = JSON.parse(stdout.text()) as StoredStepRecord;
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.evidence.http).toBe("http.jsonl");

    const lines = await readHttpJsonl(rootDir, stepRecord.evidence.dir);
    // Exactly 3: the document, the page-issued fetch, and the ctx.request()
    // call. The image/stylesheet/script never land here — no more, and no
    // duplicate of the
    // ctx.request() call landing a second time via the page path.
    expect(lines).toHaveLength(3);

    const documentEntry = lines.find((line) => line.url === `${baseURL}/`);
    expect(documentEntry).toBeDefined();
    expect(documentEntry?.via).toBe("page");
    expect(documentEntry?.method).toBe("GET");

    const pageFetchEntry = lines.find(
      (line) => typeof line.url === "string" && line.url.includes("source=page"),
    );
    expect(pageFetchEntry).toBeDefined();
    expect(pageFetchEntry?.via).toBe("page");
    // The secret in the page-issued fetch's own query string is redacted
    // the same single pass every other exit already goes through.
    expect(pageFetchEntry?.url).toContain("{{secret.API_TOKEN}}");
    expect(pageFetchEntry?.url).not.toContain(API_TOKEN);

    const requestEntry = lines.find(
      (line) => typeof line.url === "string" && line.url.includes("source=request"),
    );
    expect(requestEntry).toBeDefined();
    expect(requestEntry?.via).toBe("request");

    // The asset drop is never silent: http_omitted names what got left out.
    expect(stepRecord.http_omitted).toEqual({ image: 1, stylesheet: 1, script: 1 });

    // observed counts every request the harness saw, image/stylesheet/
    // script included — it is not narrowed by http.jsonl's own filter. Six
    // GETs total:
    // the document, three assets, the page-issued fetch, and the
    // ctx.request() call.
    expect(stepRecord.observed).toEqual({ http_reads: 6, http_writes: 0 });

    // The raw token must appear nowhere: not in stdout, not in http.jsonl or
    // record.json on disk (the same three-exits check tests/secrets.test.ts
    // already runs).
    expect(stdout.text()).not.toContain(API_TOKEN);
    const httpJsonlText = await readFile(
      path.join(rootDir, stepRecord.evidence.dir, "http.jsonl"),
      "utf8",
    );
    expect(httpJsonlText).not.toContain(API_TOKEN);
    expect(httpJsonlText).toContain("{{secret.API_TOKEN}}");
    const stepRecordText = await readFile(
      path.join(rootDir, stepRecord.evidence.dir, "record.json"),
      "utf8",
    );
    expect(stepRecordText).not.toContain(API_TOKEN);
  });

  it("nuka run: via and http_omitted land on the step's own step record", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/browse-page.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe("passed");

    const stepRecord = await readStepRecord(rootDir, record.steps[0].step_record_id as string);
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.evidence.http).toBe("http.jsonl");

    const httpLines = await readHttpJsonl(rootDir, stepRecord.evidence.dir);
    expect(httpLines).toHaveLength(3);
    expect(httpLines.filter((line) => line.via === "page")).toHaveLength(2);
    expect(httpLines.filter((line) => line.via === "request")).toHaveLength(1);
    expect(stepRecord.http_omitted).toEqual({ image: 1, stylesheet: 1, script: 1 });
  });

  it("a step whose page leaves nothing out carries no http_omitted key", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "clean-page", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text()) as StoredStepRecord;
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.http_omitted).toBeUndefined();
    expect(Object.keys(stepRecord)).not.toContain("http_omitted");

    // The lone document response is still recorded, via: "page".
    const lines = await readHttpJsonl(rootDir, stepRecord.evidence.dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.via).toBe("page");
    expect(lines[0]?.url).toBe(`${baseURL}/clean`);
  });
});
