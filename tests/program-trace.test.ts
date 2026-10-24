import { existsSync, readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  httpLogLines,
  latestRunDir,
  latestRunJson,
  removeTempDir,
  stepRecordDir,
  stepRecordIds,
  writeUrlProgram,
} from "./helpers/fixtures.js";

// Responsibility: trace context end to end against
// tests/fixtures/trace-project, whose program tags each log line with the
// request's traceparent (docs/spec.md "Program"). Each client a step can
// send through (`fetch`, `node:http`, `request`, and a Chromium page)
// carries one trace id per scenario and one span id per step, only to the
// world's origin, and each step record holds the lines of the program's
// log its own requests caused. A program that does not tag its lines, and
// a world at a URL nukadoko did not start, each get one line in the run
// summary that says why the slices are empty.

const OWN_TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface StepFacts {
  readonly step: string;
  readonly observed: { program_log?: { lines: number; file: string | null; stamped: number } | null };
  readonly dir: string;
}

/** Each step record of the latest runs, by step name. */
function stepsByName(rootDir: string): Map<string, StepFacts[]> {
  const steps = new Map<string, StepFacts[]>();
  for (const id of stepRecordIds(rootDir)) {
    const dir = stepRecordDir(rootDir, id);
    const record = JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8")) as StepFacts;
    steps.set(record.step, [...(steps.get(record.step) ?? []), { ...record, dir }]);
  }
  return steps;
}

function sliceOf(step: StepFacts): string[] {
  const file = step.observed.program_log?.file;
  if (file === null || file === undefined) return [];
  return readFileSync(path.join(step.dir, file), "utf8").trimEnd().split("\n");
}

function only<T>(items: readonly T[] | undefined): T {
  expect(items).toHaveLength(1);
  return items![0]!;
}

describe("trace context and the program's log", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("trace-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("stamps each client's requests to the world and gives each step the log lines of its own span", async () => {
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const steps = stepsByName(rootDir);
    const fetchStep = only(steps.get("fetch-program"));
    const nodeStep = only(steps.get("node-http-program"));
    const requestStep = only(steps.get("request-program"));
    const pageStep = only(steps.get("page-program"));

    // http.jsonl names the traceparent of each request nukadoko stamped:
    // the world's, and not the caller's own or another origin's.
    const fetchLines = httpLogLines(rootDir, path.basename(fetchStep.dir)) as { url: string; traceparent?: string }[];
    const byPath = new Map(fetchLines.map((line) => [new URL(line.url).pathname, line.traceparent]));
    expect([...byPath.keys()].sort()).toEqual(["/elsewhere", "/fetch", "/own"]);
    expect(byPath.get("/own")).toBeUndefined();
    expect(byPath.get("/elsewhere")).toBeUndefined();
    const [, traceId, fetchSpan] = TRACEPARENT.exec(byPath.get("/fetch") ?? "") ?? [];
    expect(traceId).toBeDefined();

    const spanOf = (step: StepFacts): string => {
      const traceparent = (httpLogLines(rootDir, path.basename(step.dir)) as { traceparent?: string }[]).find((line) => line.traceparent)?.traceparent;
      const [, trace, span] = TRACEPARENT.exec(traceparent ?? "") ?? [];
      expect(trace).toBe(traceId);
      return span!;
    };
    const nodeSpan = spanOf(nodeStep);
    const requestSpan = spanOf(requestStep);
    expect(new Set([fetchSpan, nodeSpan, requestSpan]).size).toBe(3);

    expect(fetchStep.observed.program_log).toEqual({ lines: 1, file: "program-log.txt", stamped: 1 });
    expect(sliceOf(fetchStep)).toEqual([`[00-${traceId}-${fetchSpan}-01] GET /fetch`]);
    expect(sliceOf(nodeStep)).toEqual([`[00-${traceId}-${nodeSpan}-01] GET /node`]);
    // A line a program tags with the trace id alone belongs to the step it
    // was written in.
    expect(requestStep.observed.program_log).toEqual({ lines: 2, file: "program-log.txt", stamped: 2 });
    expect(sliceOf(requestStep)).toEqual([`[00-${traceId}-${requestSpan}-01] GET /request`, `[trace=${traceId}] GET /trace-only`]);
    // The page's document and its fetch carry the step's span; the page
    // sends no request to another origin.
    const pageSlice = sliceOf(pageStep);
    expect(pageSlice.map((line) => line.replace(/^\[[^\]]+\] /, ""))).toEqual(["GET /page", "GET /from-page"]);
    const pageSpans = new Set(pageSlice.map((line) => TRACEPARENT.exec(line.slice(1, line.indexOf("]")))?.[2]));
    expect(pageSpans.size).toBe(1);
    expect([...pageSpans][0]).not.toBe(requestSpan);
    expect(pageStep.observed.program_log).toEqual({ lines: 2, file: "program-log.txt", stamped: 2 });

    // The caller's own traceparent reached the program as it was.
    const programLog = readFileSync(path.join(latestRunDir(rootDir), "worlds", "default", "program.log"), "utf8");
    expect(programLog).toContain(`[${OWN_TRACEPARENT}] GET /own`);

    const run = latestRunJson(rootDir);
    expect(run.worlds[0].program_log).toEqual({ stamped: 6, lines: 6 });
    expect(run.scenarios[0].steps.map((step: { observed: { program_log: unknown } }) => step.observed.program_log)).toEqual([
      fetchStep.observed.program_log,
      nodeStep.observed.program_log,
      requestStep.observed.program_log,
      pageStep.observed.program_log,
    ]);
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).not.toContain("program log of world");
  });

  it("gives each scenario a trace of its own under --concurrency, read from the log the parent writes", async () => {
    await copyFile(path.join(rootDir, "features", "trace.feature"), path.join(rootDir, "features", "trace-again.feature"));
    const { exitCode } = await cli(rootDir, ["run", "--concurrency", "2"]);

    expect(exitCode).toBe(0);
    const fetchSteps = stepsByName(rootDir).get("fetch-program") ?? [];
    expect(fetchSteps).toHaveLength(2);
    const traces = fetchSteps.map((step) => {
      const slice = sliceOf(step);
      expect(slice).toHaveLength(1);
      expect(slice[0]).toMatch(/GET \/fetch$/);
      return TRACEPARENT.exec(slice[0]!.slice(1, slice[0]!.indexOf("]")))?.[1];
    });
    expect(new Set(traces).size).toBe(2);
    expect(latestRunJson(rootDir).worlds[0].program_log).toEqual({ stamped: 12, lines: 12 });
  });

  it("leaves a step's slice empty when the program does not tag its lines", async () => {
    const { exitCode } = await cli(rootDir, ["run", "--env", "untagged"]);

    expect(exitCode).toBe(0);
    const fetchStep = only(stepsByName(rootDir).get("fetch-program"));
    expect(fetchStep.observed.program_log).toEqual({ lines: 0, file: null, stamped: 1 });
    expect(existsSync(path.join(fetchStep.dir, "program-log.txt"))).toBe(false);
    const run = latestRunJson(rootDir);
    // The trace-only line of the request step is still that step's.
    expect(run.worlds[0].program_log).toEqual({ stamped: 6, lines: 1 });
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).not.toContain("program log of world untagged");
  });

  it("says so in the summary when no line carries a trace id", async () => {
    // Without the request step, nothing tags a line.
    const feature = path.join(rootDir, "features", "trace.feature");
    await writeFile(feature, readFileSync(feature, "utf8").replace("    And the step asks the program through request\n", ""));
    const { exitCode } = await cli(rootDir, ["run", "--env", "untagged"]);

    expect(exitCode).toBe(0);
    expect(latestRunJson(rootDir).worlds[0].program_log).toEqual({ stamped: 4, lines: 0 });
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.includes("program log of world"))).toEqual([
      "- program log of world untagged: carries no trace ids, so each step's slice of it is empty",
    ]);
  });

  it("nuka do slices the log of the world it starts for its one execution", async () => {
    const { exitCode, stdout } = await cli(rootDir, ["do", "request-program", "--args", "{}"]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as StepFacts & { step_record_id: string };
    expect(record.observed.program_log).toEqual({ lines: 2, file: "program-log.txt", stamped: 2 });
    const slice = sliceOf({ ...record, dir: stepRecordDir(rootDir, record.step_record_id) });
    expect(slice.map((line) => line.replace(/^\[[^\]]+\] /, ""))).toEqual(["GET /request", "GET /trace-only"]);
  });
});

describe("a world at a URL nukadoko did not start", () => {
  let rootDir: string;
  let server: Server;
  const seen: (string | undefined)[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req, res) => {
      const traceparent = req.headers.traceparent;
      seen.push(typeof traceparent === "string" ? traceparent : undefined);
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    rootDir = await copyFixtureToTempDir("trace-project");
    await writeUrlProgram(rootDir, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const feature = path.join(rootDir, "features", "trace.feature");
    await writeFile(
      feature,
      ["Feature: A remote program", "", "  Scenario: one request", "    When the step asks the program through request", ""].join("\n"),
    );
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(rootDir);
  });

  it("still stamps its requests, records no slice, and says the log was not read", async () => {
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    expect(seen).toHaveLength(2);
    for (const value of seen) expect(value).toMatch(TRACEPARENT);
    const requestStep = only(stepsByName(rootDir).get("request-program"));
    expect(requestStep.observed.program_log).toBeNull();
    const run = latestRunJson(rootDir);
    expect(run.worlds[0].program_log).toBeNull();
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.includes("program log of world"))).toEqual([
      `- program log of world default: not read, since the program runs at ${run.worlds[0].url}, which nukadoko did not start`,
    ]);
  });
});
