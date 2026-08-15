import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the one browser-path session round trip
// (browser-login.ts / browser-whoami.ts against a real chromium,
// via ctx.page()) — kept in its own file, same separation as
// create-context.test.ts (node:http only) vs browser-evidence.test.ts
// (chromium) for the pre-existing evidence tests. Unlike
// browser-evidence.test.ts, this suite is not `it.skipIf`-gated: it must
// pass without skipping (chromium is expected already
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
    const beforeLogin = Date.now();
    const loginExit = await runCli(
      ["do", "browser-login", "--args", "{}", "--session", "sb1"],
      { rootDir, stdout: loginStdout, stderr: createCaptureSink() },
    );
    const afterLogin = Date.now();
    expect(loginExit).toBe(0);
    const loginStepRecord = JSON.parse(loginStdout.text());
    expect(loginStepRecord.result).toEqual({ ok: true });
    expectSingleFinalScreenshot(loginStepRecord, { notBefore: beforeLogin, notAfter: afterLogin });

    const sessionFile = path.join(rootDir, ".nukadoko", "cache", "sessions", "default", "sb1.json");
    expect(existsSync(sessionFile)).toBe(true);

    const whoamiStdout = createCaptureSink();
    const whoamiExit = await runCli(
      ["do", "browser-whoami", "--args", "{}", "--session", "sb1"],
      { rootDir, stdout: whoamiStdout, stderr: createCaptureSink() },
    );
    expect(whoamiExit).toBe(0);
    const whoamiStepRecord = JSON.parse(whoamiStdout.text());
    expect(whoamiStepRecord.result.cookie).toContain("sid=abc123");
  });

  // A browser
  // execution's step record carries exactly one screenshot, final.png,
  // whether the step passed or failed — the case the former
  // second-screenshot behavior (a second copy of the same buffer, saved
  // under a different name on a failed run only) existed for. The success
  // half is covered above (the login step record); this is the failure half.
  it("a failed browser execution's step record still carries exactly one screenshot, final.png", async () => {
    const stdout = createCaptureSink();
    const beforeRun = Date.now();
    const exitCode = await runCli(["do", "browser-throws", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    const afterRun = Date.now();

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expectSingleFinalScreenshot(stepRecord, { notBefore: beforeRun, notAfter: afterRun });
  });
});

/** Shared by both the success and failure browser step records above: exactly
 * one `final.png` entry, with an `at` that both parses as a date and falls
 * inside `bounds` — the wall-clock window the caller measured around the
 * whole `runCli` call, not the step record's own `finished_at`. `finalize()` (src/context/
 * browser-evidence.ts) runs from `dispose()`, which cli/do.ts calls *after*
 * `finished_at` is already recorded — the exact gap this field exists
 * to make visible (docs/spec.md "Records": `at` is what a second,
 * per-outcome screenshot file used to stand in for without stating it) —
 * closing that gap by moving the
 * screenshot earlier, to the moment of the throw on failure, is
 * deliberately not done. So `at > finished_at` is the expected, honest reading here,
 * not a bug — `started_at` still bounds it below (a screenshot cannot
 * predate the execution that produced it), and the wall clock around the
 * whole CLI call bounds it above, which is what "value ordering, not only
 * format" actually checks for this field. */
function expectSingleFinalScreenshot(
  stepRecord: {
    started_at: string;
    evidence: { screenshots: Array<{ file: string; at: string }> };
  },
  bounds: { notBefore: number; notAfter: number },
): void {
  expect(stepRecord.evidence.screenshots).toHaveLength(1);
  const [screenshot] = stepRecord.evidence.screenshots;
  expect(screenshot!.file).toBe("final.png");
  const at = Date.parse(screenshot!.at);
  const startedAt = Date.parse(stepRecord.started_at);
  expect(Number.isNaN(at)).toBe(false);
  expect(at).toBeGreaterThanOrEqual(startedAt);
  expect(at).toBeGreaterThanOrEqual(bounds.notBefore);
  expect(at).toBeLessThanOrEqual(bounds.notAfter);
}
