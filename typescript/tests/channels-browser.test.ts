import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, httpLogLines, latestRunDir, removeTempDir, stepRecordDir } from "./helpers/fixtures.js";

// Responsibility: a browser step's record against
// tests/fixtures/channels-browser-project, whose browser context carries
// an Authorization header and HTTP credentials that are not secrets
// nukadoko loaded. Playwright writes its trace, network log, and resources
// from the step's own async context, so without its own output directory
// those writes read as the step's file writes, with the header and the
// password in their content. The record must list none of them, name no
// unmeasured connection for the browser or the request fixture, and hold
// neither value in any file of the run.

const HEADER_VALUE = "invented-header-token-5521";
const PASSWORD = "invented-password-7730";

let server: Server;
let rootDir: string;
let previousBase: string | undefined;

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><button onclick=\"this.textContent='done'\">go</button></body></html>");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  previousBase = process.env.CHANNELS_BASE;
  process.env.CHANNELS_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rootDir = await copyFixtureToTempDir("channels-browser-project");
});

afterEach(async () => {
  if (previousBase === undefined) delete process.env.CHANNELS_BASE;
  else process.env.CHANNELS_BASE = previousBase;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeTempDir(rootDir);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const target = path.join(dir, name);
    return statSync(target).isDirectory() ? filesUnder(target) : [target];
  });
}

describe("a browser step's record", () => {
  it("lists none of Playwright's own files, names no unmeasured connection, and holds neither context credential", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records"], { rootDir, stdout, stderr });
    expect(exitCode, stderr.text()).toBe(0);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    const [opened, reached] = await Promise.all(
      record.steps.map(async (step: { step_record_id: string }) =>
        JSON.parse(await readFile(path.join(stepRecordDir(rootDir, step.step_record_id), "record.json"), "utf8")),
      ),
    );
    expect(opened.observed).toMatchObject({ processes: null, files: null, unmeasured: [] });
    expect(reached.observed).toEqual({ processes: null, http: 1, files: null, unmeasured: [] });
    expect(httpLogLines(rootDir, reached.step_record_id).map((line) => [line.via, line.url])).toEqual([
      ["request", `${process.env.CHANNELS_BASE}/api`],
    ]);
    // Every text nukadoko wrote for the run. The trace archive is
    // Playwright's own format, compressed, and holds the context options
    // as Playwright records them; it is not part of the step record.
    const written = filesUnder(latestRunDir(rootDir)).filter((file) => !file.endsWith(".zip"));
    expect(written.map((file) => path.basename(file))).toEqual(expect.arrayContaining(["run.json", "summary.md", "record.json"]));
    const holding = written.filter((file) => {
      const text = readFileSync(file, "latin1");
      return text.includes(HEADER_VALUE) || text.includes(PASSWORD);
    });
    expect(holding).toEqual([]);
  }, 120_000);
});
