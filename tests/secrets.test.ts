import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: proves docs/spec.md "Secrets" end to end through the real
// `nuka do` executor — secrets-project's ".env.secret" is a secret source
// (git does not track it: .gitignore's `.env.*` pattern excludes it, and a
// copy under tests/.tmp-fixtures is doubly untracked regardless), and
// leak-secret.ts puts every value it defines into both `result` and an
// outbound request's URL. The assertion that matters is the *absence* of
// the raw secret value from all three exits docs/spec.md names —
// record.json, `do`'s stdout copy, and http.jsonl — checked by scanning
// each artifact's actual file/string content, not just a couple of
// `toContain` calls on a parsed field.

const API_TOKEN = "sekrit-value-123";
const PUBLIC_TOKEN = "not-a-real-secret";

function startEchoServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function writeConfig(
  rootDir: string,
  baseURL: string,
  publicKeys: readonly string[],
): Promise<void> {
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    [
      'import { defineConfig } from "./nukadoko-shim.js";',
      "export default defineConfig({",
      `  baseURL: "${baseURL}",`,
      '  envFiles: [".env.secret"],',
      `  secrets: { public: ${JSON.stringify(publicKeys)} },`,
      "});",
      "",
    ].join("\n"),
  );
}

describe("secret redaction (nuka do integration)", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startEchoServer());
    rootDir = await copyFixtureToTempDir("secrets-project");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("redacts every secret-source value from record.json, stdout, and http.jsonl", async () => {
    await writeConfig(rootDir, baseURL, []);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "leak-secret", "--args", "{}"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");

    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.result).toEqual({
      apiToken: "{{secret.API_TOKEN}}",
      publicToken: "{{secret.PUBLIC_TOKEN}}",
    });

    const recordPath = path.join(rootDir, stepRecord.evidence.dir, "record.json");
    const stepRecordText = await readFile(recordPath, "utf8");
    const httpLogPath = path.join(rootDir, stepRecord.evidence.dir, "http.jsonl");
    const httpLogText = await readFile(httpLogPath, "utf8");

    // The raw values must appear nowhere: not in stdout, not in
    // record.json on disk, not in http.jsonl's logged URL.
    for (const rawValue of [API_TOKEN, PUBLIC_TOKEN]) {
      expect(stdout.text()).not.toContain(rawValue);
      expect(stepRecordText).not.toContain(rawValue);
      expect(httpLogText).not.toContain(rawValue);
    }

    expect(stepRecordText).toContain("{{secret.API_TOKEN}}");
    expect(httpLogText).toContain("{{secret.API_TOKEN}}");
    expect(httpLogText).toContain("{{secret.PUBLIC_TOKEN}}");
  });

  it("secrets.public demotes a named key so its value is never redacted", async () => {
    await writeConfig(rootDir, baseURL, ["PUBLIC_TOKEN"]);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "leak-secret", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.result).toEqual({
      apiToken: "{{secret.API_TOKEN}}",
      publicToken: PUBLIC_TOKEN,
    });

    const httpLogPath = path.join(rootDir, stepRecord.evidence.dir, "http.jsonl");
    const httpLogText = await readFile(httpLogPath, "utf8");

    // The demoted key's raw value now appears (it is plain, not secret);
    // the other key's value must still never appear anywhere.
    expect(httpLogText).toContain(PUBLIC_TOKEN);
    expect(httpLogText).not.toContain(API_TOKEN);
    expect(stdout.text()).not.toContain(API_TOKEN);
  });
});
