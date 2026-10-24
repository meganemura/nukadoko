import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: which of Playwright's file writes a step's record lists,
// for a browser nukadoko did not launch (src/context/write-origin.ts). A
// compat World launches its own browser and context outside any step, with
// tracing on, a HAR, and a video, so nothing tells nukadoko where
// Playwright will write. The context carries an Authorization header and
// HTTP credentials that are not secrets nukadoko loaded. Playwright's
// server runs in the step's process and async context, so its trace,
// network log, resource, HAR, and video writes would read as the step's
// files, credentials included in their content. The record must list none
// of them, and must still list every file the step asked Playwright for.

const HEADER_VALUE = "invented-header-token-6143";
const PASSWORD = "invented-password-2287";

let server: Server;
let base: string;

beforeAll(async () => {
  installChannelPatches();
  server = createServer((req, res) => {
    if (req.url === "/file") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=a.txt" });
      res.end("downloaded");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<button onclick="this.textContent='done'">go</button><a href="/file" download>get</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let dir: string;
let browser: Browser;
let context: BrowserContext;
let observed: ObservedCollector;

beforeEach(async () => {
  dir = await createEmptyTempDir();
  // The World's own setup, outside any step. `tracesDir` keeps Playwright's
  // call-stack file in a directory the test names: without it, Playwright
  // keeps it in a temporary directory of its own, which `tracing.stop`
  // removes on the step's behalf, and the record lists that removal.
  browser = await chromium.launch({ tracesDir: path.join(dir, "world", "traces") });
  context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${HEADER_VALUE}` },
    httpCredentials: { username: "someone", password: PASSWORD },
    recordHar: { path: path.join(dir, "world", "network.har") },
    recordVideo: { dir: path.join(dir, "world", "video") },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  observed = createObservedCollector({ outputDir: () => path.join(dir, "record"), unwatchedDirs: [path.join(dir, "state")] });
});

afterEach(async () => {
  await browser.close();
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

function holdsCredential(file: string): boolean {
  const text = readFileSync(file, "latin1");
  return text.includes(HEADER_VALUE) || text.includes(PASSWORD);
}

describe("Playwright's file writes in a step that drives a browser it did not launch", () => {
  it("lists none of the writes Playwright's server makes on its own", async () => {
    const page = await context.newPage();
    await inStep(async () => {
      await page.goto(`${base}/`);
      await page.click("button");
      // Ends the page's video and writes the HAR, both from Playwright's
      // server, inside the step.
      await context.close();
    });
    await observed.flush();
    expect(observed.snapshot()).toEqual({ processes: null, http: null, files: null, unmeasured: [] });
    // The writes happened, and they hold the context's credentials: what
    // the record leaves out is real, not absent.
    expect(holdsCredential(path.join(dir, "world", "network.har"))).toBe(true);
  }, 60_000);

  it("lists each file the step asked Playwright to write, and none of Playwright's own", async () => {
    const page = await context.newPage();
    const out = path.join(dir, "out");
    await inStep(async () => {
      await page.goto(`${base}/`);
      await page.click("button");
      await page.screenshot({ path: path.join(out, "shot.png") });
      await context.storageState({ path: path.join(out, "state.json") });
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("a")]);
      // Waits for the download to finish first. A `saveAs` called earlier
      // is carried out when the browser reports the end, from the
      // browser connection's async context, which is not the step's: the
      // spec names that limit.
      await download.path();
      await download.saveAs(path.join(out, "saved.txt"));
      await context.tracing.stop({ path: path.join(out, "trace.zip") });
    });
    await observed.flush();
    const { files, unmeasured } = observed.snapshot();
    expect(unmeasured).toEqual([]);
    expect(files?.map((file) => [file.path, file.change])).toEqual([
      [`${out}/`, "added"],
      [path.join(out, "saved.txt"), "added"],
      [path.join(out, "shot.png"), "added"],
      [path.join(out, "state.json"), "added"],
      [path.join(out, "trace.zip"), "added"],
    ]);
    expect(files?.find((file) => file.path.endsWith("saved.txt"))?.content).toEqual({ text: "downloaded", bytes: 10 });
  }, 60_000);
});
