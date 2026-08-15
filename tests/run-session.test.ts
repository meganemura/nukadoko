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

// Responsibility: `--session` propagation *between scenarios of the same
// run* (a
// fresh ctx per scenario, storageState carried only via the session file).
// session-flow.feature's two scenarios each get their own ctx; the second
// can only see the first's cookie by cli/run.ts re-reading the session file
// at the second scenario's own start.

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

describe("nuka run --session", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("run-session-project");
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

  it("propagates the first scenario's cookie to the second via the session file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/session-flow.feature", "--session", "sf1"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].status).toBe("passed");
    expect(records[1].status).toBe("passed");
    expect(records[0].session).toBe("sf1");
    expect(records[1].session).toBe("sf1");

    expect(
      existsSync(path.join(rootDir, ".nukadoko", "cache", "sessions", "default", "sf1.json")),
    ).toBe(true);

    const secondStepRecordPath = path.join(
      rootDir,
      ".nukadoko",
      "records",
      "steps",
      records[1].steps[0].record,
      "record.json",
    );
    const secondStepRecord = JSON.parse(await readFile(secondStepRecordPath, "utf8"));
    expect(secondStepRecord.result.cookie).toContain("sid=abc123");
  });
});
