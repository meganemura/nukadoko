import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
} from "./helpers/fixtures.js";

// Responsibility: the exact `observed` and `args_origin` a step record
// carries after `nuka run`, against tests/fixtures/channels-project: a
// fetch with its bodies in http.jsonl, the files a step and its command
// wrote in a scratch directory, the command's environment and stdin, an
// action nukadoko cannot measure and the run summary's line for it, a
// request and a command a step left behind that start after its record
// was written, the step's own channels never read as an unmeasured
// connection (also across --concurrency workers), and where each argument
// of a chained step came from.

const node = process.execPath;

let server: Server;
let rootDir: string;
let previousBase: string | undefined;

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ got: body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  previousBase = process.env.CHANNELS_BASE;
  process.env.CHANNELS_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rootDir = await copyFixtureToTempDir("channels-project");
});

afterEach(async () => {
  if (previousBase === undefined) delete process.env.CHANNELS_BASE;
  else process.env.CHANNELS_BASE = previousBase;
  await new Promise((resolve) => server.close(resolve));
  await removeTempDir(rootDir);
});

async function runLine(line: number | string): Promise<Record<string, any>[]> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const target = typeof line === "number" ? `features/channels.feature:${line}` : line;
  const exitCode = await runCli(["run", "--records", target], { rootDir, stdout, stderr });
  expect(exitCode, stderr.text()).toBe(0);
  const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
  return Promise.all(
    record.steps.map(async (step: { step_record_id: string }) =>
      JSON.parse(await readFile(path.join(stepRecordDir(rootDir, step.step_record_id), "record.json"), "utf8")),
    ),
  );
}

describe("a step record's observed", () => {
  it("holds the request, the files, and the command, and http.jsonl holds the bodies", async () => {
    const [stepRecord] = await runLine(3);
    const { observed } = stepRecord!;
    const dir = observed.processes[0].cwd as string;
    expect(path.basename(dir)).toMatch(/^kept-/);
    const reply = '{"got":"{\\"token\\":\\"{{secret.CHANNEL_TOKEN}}\\"}"}';
    const replyBytes = Buffer.byteLength(JSON.stringify({ got: JSON.stringify({ token: "channel-token-value" }) }));
    expect(observed).toEqual({
      processes: [
        {
          command: [node, "-e", "require('node:fs').copyFileSync('reply.json', 'copy.json')"],
          cwd: dir,
          exit_code: 0,
          duration_ms: expect.any(Number),
          files: { added: ["copy.json"], changed: [], removed: [] },
          env: { inherited: true },
          stdin: "process-1.stdin.txt",
        },
      ],
      http: 1,
      files: [
        { path: `${dir}/`, change: "added" },
        { path: path.join(dir, "copy.json"), change: "added", bytes: replyBytes, content: { text: reply, bytes: replyBytes } },
        { path: path.join(dir, "reply.json"), change: "added", bytes: replyBytes, content: { text: reply, bytes: replyBytes } },
      ],
      unmeasured: [],
    });
    expect(readFileSync(path.join(rootDir, stepRecord!.evidence.dir, "process-1.stdin.txt"), "utf8")).toBe("unused");
    const sent = JSON.stringify({ token: "channel-token-value" });
    expect(httpLogLines(rootDir, stepRecord!.step_record_id)).toEqual([
      {
        method: "POST",
        url: `${process.env.CHANNELS_BASE}/echo`,
        status: 200,
        duration_ms: expect.any(Number),
        via: "fetch",
        request_body: { text: '{"token":"{{secret.CHANNEL_TOKEN}}"}', bytes: Buffer.byteLength(sent) },
        response_body: { text: reply, bytes: replyBytes },
      },
    ]);
    // run.json names each file and its size; the content stays in the record.
    const runStep = latestRunJson(rootDir).scenarios[0].steps[0];
    expect(runStep.observed.files.map((entry: Record<string, unknown>) => Object.keys(entry))).toEqual([
      ["path", "change"],
      ["path", "change", "bytes"],
      ["path", "change", "bytes"],
    ]);
  });

  it("names an action nukadoko cannot measure, and the run summary gives the step one line", async () => {
    const [stepRecord] = await runLine(6);
    expect(stepRecord!.observed).toEqual({
      processes: null,
      http: null,
      files: null,
      unmeasured: [{ kind: "child_process", detail: "execFileSync node with 2 arguments" }],
    });
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain(
      "- `features/channels.feature:7` a step starts a process without runCommand: child process `execFileSync node with 2 arguments`; start a process with `runCommand` to record it; record `",
    );
  });
});

describe("an action a step started after its record was written", () => {
  it("is written beside that step's record, marked after_step_end, never into the next step's files, and the run summary names it once", async () => {
    const [left, waited] = await runLine(16);
    // The record was written before the actions started, and is not rewritten.
    const cwd = left!.observed.files[0].path.slice(0, -1);
    expect(left!.observed).toEqual({ processes: null, http: null, files: [{ path: `${cwd}/`, change: "added" }], unmeasured: [] });
    expect(httpLogLines(rootDir, left!.step_record_id)).toEqual([
      {
        method: "POST",
        url: `${process.env.CHANNELS_BASE}/late`,
        status: 200,
        duration_ms: expect.any(Number),
        via: "fetch",
        request_body: { text: "late", bytes: 4 },
        response_body: { text: '{"got":"late"}', bytes: 14 },
        after_step_end: true,
      },
    ]);
    const leftDir = path.join(rootDir, left!.evidence.dir);
    expect(JSON.parse(readFileSync(path.join(leftDir, "process-1.json"), "utf8"))).toEqual({
      command: [node, "-e", "process.stdout.write('late')"],
      cwd,
      exit_code: 0,
      duration_ms: expect.any(Number),
      files: { added: [], changed: [], removed: [] },
      env: { inherited: true },
      stdout: "process-1.stdout.txt",
      after_step_end: true,
    });
    expect(readFileSync(path.join(leftDir, "process-1.stdout.txt"), "utf8")).toBe("late");
    const waitedDir = path.join(rootDir, waited!.evidence.dir);
    expect(existsSync(waitedDir) ? readdirSync(waitedDir).filter((name) => name === "http.jsonl" || name.startsWith("process-")) : []).toEqual([]);
    expect(waited!.observed).toEqual({ processes: null, http: null, files: null, unmeasured: [] });
    const steps = latestRunJson(rootDir).scenarios[0].steps;
    expect(steps.map((step: Record<string, unknown>) => step.after_step_end)).toEqual([{ requests: 1, processes: 1 }, undefined]);
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.match(/started after the step ended/g)).toHaveLength(1);
    expect(summary).toContain(
      `- \`features/channels.feature:17\` a step leaves a request and a command for later: started after the step ended: 1 request, 1 process; record \``,
    );
  });
});

describe("the step's own channels", () => {
  it("are never an unmeasured connection: console output, the request fixture, fetch, node:http, and a command's stdin", async () => {
    const [stepRecord] = await runLine("features/own-channels.feature");
    expect(stepRecord!.observed).toMatchObject({ http: 3, unmeasured: [] });
    expect(stepRecord!.observed.processes).toHaveLength(1);
    expect(httpLogLines(rootDir, stepRecord!.step_record_id).map((line) => line.via)).toEqual(["request", "fetch", "node:http"]);
  });

  it("are never an unmeasured connection across --concurrency workers either", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--concurrency", "2", "features/own-channels.feature", "features/channels.feature"], { rootDir, stdout, stderr });
    expect(exitCode, stderr.text()).toBe(0);
    const unmeasured = latestRunJson(rootDir).scenarios.flatMap((scenario: Record<string, any>) =>
      scenario.steps.flatMap((step: Record<string, any>) => step.observed?.unmeasured ?? []),
    );
    // The one process the fixture starts without runCommand, and nothing else.
    expect(unmeasured).toEqual([{ kind: "child_process", detail: "execFileSync node with 2 arguments" }]);
  });
});

describe("a step record's args_origin", () => {
  it("names a capture, the docstring, an earlier step's result, and the schema's default", async () => {
    const [created, shipped] = await runLine(9);
    expect(created!.args_origin).toBeUndefined();
    expect(shipped!.args).toEqual({ color: "blue", note: "fragile", orderId: "order-1", priority: 1 });
    expect(shipped!.args_origin).toEqual({
      color: "capture",
      note: "docstring",
      orderId: { from: { step_record_id: created!.step_record_id, step: "create-order", key: "id" } },
      priority: "schema",
    });
  });
});
