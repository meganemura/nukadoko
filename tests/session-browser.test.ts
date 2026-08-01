import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the one browser-path session round trip this task's spec
// asks for (browser-login.ts / browser-whoami.ts against a real chromium,
// via ctx.page()) — kept in its own file, same separation as
// create-context.test.ts (node:http only) vs browser-evidence.test.ts
// (chromium) for the pre-existing evidence tests. Unlike
// browser-evidence.test.ts, this suite is not `it.skipIf`-gated: the task
// spec requires it to pass without skipping (chromium is expected already
// installed in this environment).

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

describe("nuka do --session (browser path)", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("session-project");
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

  it("restores a cookie the browser context picked up in an earlier `do` call under the same session", async () => {
    const loginStdout = createCaptureSink();
    const loginExit = await runCli(
      ["do", "browser-login", "--args", "{}", "--session", "sb1"],
      { rootDir, stdout: loginStdout, stderr: createCaptureSink() },
    );
    expect(loginExit).toBe(0);
    expect(JSON.parse(loginStdout.text()).result).toEqual({ ok: true });

    const sessionFile = path.join(rootDir, ".nukadoko", "sessions", "default", "sb1.json");
    expect(existsSync(sessionFile)).toBe(true);

    const whoamiStdout = createCaptureSink();
    const whoamiExit = await runCli(
      ["do", "browser-whoami", "--args", "{}", "--session", "sb1"],
      { rootDir, stdout: whoamiStdout, stderr: createCaptureSink() },
    );
    expect(whoamiExit).toBe(0);
    const whoamiReceipt = JSON.parse(whoamiStdout.text());
    expect(whoamiReceipt.result.cookie).toContain("sid=abc123");
  });
});
