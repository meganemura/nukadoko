import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stepRecordDir, writeUrlProgram } from "./helpers/fixtures.js";

// Responsibility: the fits-aria-snapshot compare on a real page, through
// `nuka run`: a claim on the page and one on a locator hold on trees that
// name part of what the page shows, the record keeps the snapshot the
// browser printed as the actual value, and a claim on a node the page
// does not have breaks with a line that names the first expected line that
// fits nothing and the nearest node.

/** The room page. aria-snapshot.test.ts judges, word for word, the
 * snapshot the browser prints for it (`PRINTED` below). */
const ROOM_PAGE =
  '<!doctype html><html><head><title>Room 7</title></head><body><main><h1>Room 7</h1><form aria-label="Scores"><label>Nickname <input value="aki"></label><button>Score</button><button disabled>Skip</button></form><nav><a href="/help">Help</a></nav><ul><li>one</li><li>two</li></ul></main></body></html>';

const PRINTED = [
  "- main:",
  '  - heading "Room 7" [level=1]',
  '  - form "Scores":',
  "    - text: Nickname",
  '    - textbox "Nickname": aki',
  '    - button "Score"',
  '    - button "Skip" [disabled]',
  "  - navigation:",
  '    - link "Help":',
  "      - /url: /help",
  "  - list:",
  "    - listitem: one",
  "    - listitem: two",
].join("\n");

function startRoomServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/rooms/7") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(ROOM_PAGE);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

interface StepLine {
  status: string;
  step_record_id: string;
  error?: { message: string; kind: string };
}

interface ClaimRecordShape {
  actual?: unknown;
  actual_from: string;
  outcome: string;
  reason?: string;
}

describe("nuka run with fits-aria-snapshot", () => {
  let server: Server;
  let rootDir: string;

  beforeEach(async () => {
    const started = await startRoomServer();
    server = started.server;
    rootDir = await copyFixtureToTempDir("aria-project");
    await writeUrlProgram(rootDir, started.baseURL);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("holds on part of the page and part of a form, and breaks naming the first expected line that fits nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/room.feature"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    const [holds, breaks] = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string; steps: StepLine[] });
    expect(holds!.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed"]);
    const claimsOf = async (step: StepLine): Promise<ClaimRecordShape[]> =>
      (JSON.parse(await readFile(path.join(stepRecordDir(rootDir, step.step_record_id), "record.json"), "utf8")) as { claims: ClaimRecordShape[] }).claims;
    const [onPage] = await claimsOf(holds!.steps[1]!);
    expect(onPage).toMatchObject({ actual: PRINTED, actual_from: "ARIA snapshot of observe:page", outcome: "held" });
    const [onForm] = await claimsOf(holds!.steps[2]!);
    expect(onForm).toMatchObject({ actual_from: "ARIA snapshot of observe:form", outcome: "held" });
    // A locator's snapshot starts at the element itself.
    expect(onForm!.actual).toBe(PRINTED.split("\n").slice(2, 7).map((line) => line.slice(2)).join("\n"));

    expect(breaks!.steps.map((step) => step.status)).toEqual(["passed", "failed"]);
    const failed = breaks!.steps[1]!;
    expect(failed.error!.kind).toBe("claim_broken");
    // The line cuts a value past 120 characters of its JSON; the record
    // keeps it whole.
    expect(failed.error!.message).toBe(
      `claim broken: ${JSON.stringify(PRINTED).slice(0, 120)}... (ARIA snapshot of observe:page) fits-aria-snapshot ${JSON.stringify('- form "Scores":\n  - button "Submit"')} (sentence:tree); ` +
        'expected line 2 (button "Submit") fits no child of form "Scores" (actual line 3); nearest: button "Skip" [disabled] (actual line 7)',
    );
  }, 60_000);
});
