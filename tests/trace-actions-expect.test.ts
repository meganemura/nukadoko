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

// Responsibility: the one accepted-but-unverified corner of the per-step
// trace's own guarantee, that a wait inside `expect(...)` itself gets
// recorded in `actions` with a `ms` duration — trace-actions.test.ts already
// fixed `parseTraceActions` against a hand-built trace, and
// trace-actions-step-record.test.ts already proves `goto`'s own `url`
// reaches a real step record end to end, but
// neither exercises a real `expect(...).toBeVisible()` retrying against a
// real chromium. This file is that missing leg: the fixture page's own
// `#late` element is added by client-side JS 600ms after load, so the
// assertion in tests/fixtures/trace-actions-project/features/steps/wait-for-
// late-element.ts must actually poll and wait rather than pass on its first
// check, and this test pins the resulting step record's `actions` entry down
// to prove `ms` reflects that real wait (a lower bound only: no upper
// bound, since machine load can only push the real duration
// up from 600ms, never down).

const LATE_ELEMENT_DELAY_MS = 600;
// Comfortably below the 600ms the fixture page's own script waits before
// adding #late, leaving headroom for JS timer imprecision and the time the
// page itself takes to load before the delayed script even starts running
// (fix a lower bound only, never an upper one).
const MIN_EXPECTED_WAIT_MS = 400;

function startLateElementServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        [
          "<html><body>",
          "<script>",
          `setTimeout(() => {`,
          `  const el = document.createElement("div");`,
          `  el.id = "late";`,
          `  el.textContent = "late";`,
          `  document.body.appendChild(el);`,
          `}, ${LATE_ELEMENT_DELAY_MS});`,
          "</script>",
          "</body></html>",
        ].join("\n"),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

interface StoredStepRecord {
  status: string;
  actions?: Array<{
    method: string;
    expression?: string;
    selector?: string;
    ms: number;
    outcome: string;
  }>;
}

describe("actions on the step record: a real expect() wait", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startLateElementServer());
    rootDir = await copyFixtureToTempDir("trace-actions-project");
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

  it("records the expect() call's real wait time in actions[].ms, not zero", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/wait-for-late-element.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe("passed");

    const stepRecordPath = path.join(
      rootDir,
      ".nukadoko",
      "records",
      "steps",
      record.steps[0].step_record_id as string,
      "record.json",
    );
    const stepRecord = JSON.parse(await readFile(stepRecordPath, "utf8")) as StoredStepRecord;
    expect(stepRecord.status).toBe("ok");

    const expectAction = (stepRecord.actions ?? []).find((action) => action.method === "expect");
    expect(expectAction).toBeDefined();
    expect(expectAction?.expression).toBe("to.be.visible");
    expect(expectAction?.selector).toBe("#late");
    expect(expectAction?.outcome).toBe("passed");
    // The real assertion: proof the recorded wait is the actual retry time
    // against a live browser, not a placeholder or an instant pass.
    expect(expectAction?.ms).toBeGreaterThan(MIN_EXPECTED_WAIT_MS);
  });
});
