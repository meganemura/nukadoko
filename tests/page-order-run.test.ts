import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what a Then's record and the run summary say the page
// had received from the world when the Then read it, end to end through
// `nuka run` against tests/fixtures/page-order-project, whose program
// holds back the answer to a refresh: one Then reads a page whose last
// answer finished, one reads it while the refresh is in flight and holds
// on the old text, a polled one reads until the held answer arrives, and
// one reads two tabs that sent the same request in one step.

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

interface ThenRecord {
  readonly record: Record<string, any>;
  readonly runStep: Record<string, any>;
  readonly earlier: readonly { readonly step_record_id: string; readonly step: string; readonly line: number }[];
}

describe.skipIf(!chromiumAvailable)("what the page had received when a Then read it", () => {
  let rootDir: string;
  let exitCode: number;
  let thens: ThenRecord[];
  let summary: string;
  let origin: string;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("page-order-project");
    exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    const runDir = latestRunDir(rootDir);
    const run = latestRunJson(rootDir);
    origin = run.worlds[0].url;
    thens = run.scenarios.map((scenario: { steps: Record<string, any>[] }) => {
      const runStep = scenario.steps.at(-1)!;
      return {
        runStep,
        record: JSON.parse(readFileSync(path.join(runDir, runStep.record, "record.json"), "utf8")),
        earlier: scenario.steps.slice(0, -1).map((step) => ({ step_record_id: step.step_record_id, step: step.step, line: step.line })),
      };
    });
    summary = readFileSync(path.join(runDir, "summary.md"), "utf8");
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("passes every scenario: what the page had received never changes a claim's outcome", () => {
    expect(exitCode).toBe(0);
    expect(thens.map((then) => then.runStep.status)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("names the response the page last finished receiving, sent during the earlier step that opened it, and nothing in flight", () => {
    const [{ record, runStep, earlier }] = thens as [ThenRecord];
    expect(record.pages).toEqual([{ as: null, page: 1, url: `${origin}/room`, last_response: 0, in_flight: [] }]);
    expect(record.page_requests).toEqual([
      { method: "GET", url: `${origin}/state`, trace_id: expect.stringMatching(TRACE_ID), span_id: expect.stringMatching(SPAN_ID), sent_at: expect.stringMatching(TIME), finished_at: expect.stringMatching(TIME), sent_during: "earlier-step", step: earlier[0] },
    ]);
    // The trace id the page's request went out with is the earlier step's.
    expect(record.page_requests[0].trace_id).toBe(trace(earlier[0]!.step_record_id));
    expect(record.readings).toBeUndefined();
    expect(runStep.pages).toEqual(record.pages);
    expect(runStep.page_requests).toEqual(record.page_requests);
    expect(summary).toContain('- `features/room.feature:5` the room shows "ready"\n');
  });

  it("names a request still in flight while the Then read, in the record and on the summary's line, with the claim held as judged", () => {
    const { record, earlier } = thens[1]!;
    expect(record.pages).toEqual([{ as: null, page: 1, url: `${origin}/room`, last_response: 0, in_flight: [1] }]);
    expect(record.page_requests[1]).toEqual({
      method: "GET",
      url: `${origin}/state?hold=1500`,
      sent_at: expect.stringMatching(TIME),
      finished_at: null,
      sent_during: "earlier-step",
      step: earlier[1],
    });
    expect(record.claims.map((claim: { outcome: string }) => claim.outcome)).toEqual(["held"]);
    expect(summary).toContain(
      `- \`features/room.feature:10\` the room shows "ready", read with a request in flight (GET ${origin}/state?hold=1500 on page 1, sent during the step at line 9)\n`,
    );
    expect(summary).toContain("An entry read with a request in flight names each request a page sent to the world that was in flight during the reading the claims were judged on");
  });

  it("keeps each reading's pages under the change points rule, and the judged reading has the held response finished", () => {
    const { record } = thens[2]!;
    const held = record.page_requests.findIndex((request: { url: string }) => request.url === `${origin}/state?hold=600`);
    expect(held).toBeGreaterThan(-1);
    expect(record.page_requests[held]).toMatchObject({ trace_id: expect.stringMatching(TRACE_ID), span_id: expect.stringMatching(SPAN_ID), finished_at: expect.stringMatching(TIME), sent_during: "earlier-step" });
    const seen = record.readings.map((reading: { held: boolean; pages: { last_response: number; in_flight: number[] }[] }) => [reading.held, reading.pages[0]!.in_flight.includes(held), reading.pages[0]!.last_response === held]);
    // Broken while the answer was in flight, held once the page had it.
    expect(seen[0]).toEqual([false, true, false]);
    expect(seen.at(-1)).toEqual([true, false, true]);
    expect(seen.every(([holds, inFlight, last]: boolean[]) => holds === last && inFlight === !last)).toBe(true);
    expect(record.pages).toEqual(record.readings.at(-1).pages);
    expect(summary).toMatch(new RegExp(`- \`features/room\\.feature:15\` the room comes to show "refreshed", ${record.attempts} readings\\n`));
  });

  it("tells two tabs' requests of one step apart by span id, each the one on its own http.jsonl line and the program's request line", () => {
    const { record, earlier } = thens[3]!;
    expect(record.pages).toEqual([
      { as: null, page: 1, url: `${origin}/room`, last_response: 0, in_flight: [] },
      { as: null, page: 2, url: `${origin}/room`, last_response: 1, in_flight: [] },
    ]);
    const [first, second] = record.page_requests as { url: string; trace_id: string; span_id: string; step: unknown }[];
    for (const request of [first!, second!]) {
      expect(request).toMatchObject({ url: `${origin}/state`, trace_id: trace(earlier[0]!.step_record_id), span_id: expect.stringMatching(SPAN_ID), step: earlier[0] });
    }
    expect(first!.span_id).not.toBe(second!.span_id);

    const opened = readFileSync(path.join(latestRunDir(rootDir), "steps", earlier[0]!.step_record_id, "http.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { url: string; via: string; traceparent?: string; traceparent_sent_to?: string[] });
    const pageLines = opened.filter((line) => line.via === "page");
    // Two documents and two fetches, each with the header it went out with.
    expect(pageLines.map((line) => line.url).sort()).toEqual([`${origin}/room`, `${origin}/room`, `${origin}/state`, `${origin}/state`]);
    for (const line of pageLines) expect(line.traceparent_sent_to).toEqual([origin]);
    const programLog = readFileSync(path.join(latestRunDir(rootDir), "steps", earlier[0]!.step_record_id, "program-log.txt"), "utf8");
    for (const request of [first!, second!]) {
      const traceparent = `00-${request.trace_id}-${request.span_id}-01`;
      expect(pageLines.filter((line) => line.traceparent === traceparent).map((line) => line.url)).toEqual([`${origin}/state`]);
      expect(programLog).toContain(`${traceparent} GET /state\n`);
    }
  });

  /** The trace id of the step record `id`, from the program's log slice. */
  function trace(id: string): string {
    const record = JSON.parse(readFileSync(path.join(latestRunDir(rootDir), "steps", id, "record.json"), "utf8"));
    return record.observed.program_log.trace_id;
  }
});
