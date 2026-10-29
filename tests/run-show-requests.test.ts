import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { contextFileName, isValidContextName, requestsTraceFileName } from "../src/context/context-name.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stepRecordDir, stripRunProgressLines, writeUrlProgram } from "./helpers/fixtures.js";
import { zipEntries } from "./helpers/zip-entries.js";

// Responsibility: `showRequests` through a real `nuka run` and a real
// browser. A step that sends a request from its own process, through
// `ctx.request()` or plain `fetch`, gets a requests trace whose page shows
// what was sent and what came back, redacted the way http.jsonl is; a step
// that sends nothing gets none; and a browser that cannot start costs the
// trace with one warning, never the step.

const TOKEN = "tok-9f3a-hidden";

function startServer(): Promise<{ server: Server; baseURL: string }> {
  const notes: { text: string }[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "POST") {
          const { text } = JSON.parse(body) as { text: string };
          notes.push({ text });
          res.statusCode = 201;
          res.end(JSON.stringify({ id: notes.length, text }));
          return;
        }
        res.end(JSON.stringify(notes));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

interface StepRecord {
  readonly step: string;
  readonly evidence: { readonly dir: string; readonly http?: string; readonly requests_trace?: string; readonly trace?: string };
  readonly actions?: readonly unknown[];
}

async function stepRecords(rootDir: string, stdout: string): Promise<StepRecord[]> {
  const [scenario] = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { steps: { step_record_id: string }[] });
  return Promise.all(
    scenario!.steps.map(
      async (step) => JSON.parse(await readFile(path.join(stepRecordDir(rootDir, step.step_record_id), "record.json"), "utf8")) as StepRecord,
    ),
  );
}

describe("nuka run with showRequests", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startServer());
    rootDir = await copyFixtureToTempDir("run-show-requests-project");
    await writeUrlProgram(rootDir, baseURL);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("draws each step's own requests on a traced page, redacted, and nothing for a step that sends none", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/notes.feature"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(exitCode).toBe(0);
    const [addNote, addNoteWithToken, nothingSent, notesInclude] = await stepRecords(rootDir, stdout.text());

    for (const record of [addNote!, addNoteWithToken!, notesInclude!]) {
      expect(record.evidence.requests_trace).toBe("requests.zip");
      // The drawing is nukadoko's, not the step's: no page trace, no actions.
      expect(record.evidence.trace).toBeUndefined();
      expect(record.actions).toBeUndefined();
    }
    expect(nothingSent!.evidence.requests_trace).toBeUndefined();

    const traceOf = async (record: StepRecord): Promise<{ trace: string; all: string }> => {
      const entries = await zipEntries(path.join(rootDir, record.evidence.dir, record.evidence.requests_trace!));
      return {
        trace: entries.get("trace.trace")!.toString("utf8"),
        all: [...entries.values()].map((entry) => entry.toString("latin1")).join("\n"),
      };
    };

    // One group per request, named the way the trace viewer lists it, and
    // the page's snapshot holds the bodies.
    const added = await traceOf(addNote!);
    expect(added.trace).toContain('"title":"POST /notes → 201"');
    const snapshots = added.trace.split("\n").filter((line) => line.includes('"frame-snapshot"'));
    expect(snapshots.some((line) => line.includes("milk") && line.includes("201"))).toBe(true);

    // A plain fetch is drawn too, from the redacted line: the token never
    // reaches the trace, and the placeholder http.jsonl holds does.
    const withToken = await traceOf(addNoteWithToken!);
    expect(withToken.trace).toContain('"title":"POST /notes?key={{secret.NOTE_TOKEN}} → 201"');
    expect(withToken.all).not.toContain(TOKEN);
    expect(withToken.trace).toContain("{{secret.NOTE_TOKEN}}");
    const http = await readFile(path.join(rootDir, addNoteWithToken!.evidence.dir, "http.jsonl"), "utf8");
    expect(http).toContain("{{secret.NOTE_TOKEN}}");

    const read = await traceOf(notesInclude!);
    expect(read.trace).toContain('"title":"GET /notes → 200"');
  });

  it("warns once and keeps every step when the browser cannot start", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        'export default defineConfig({ showRequests: true, envFiles: [".env"], browser: { executablePath: "/no/such/browser" } });',
        "",
      ].join("\n"),
    );
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/notes.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const warnings = stripRunProgressLines(stderr.text())
      .split("\n")
      .filter((line) => line.includes("show-requests-failed"));
    expect(warnings).toHaveLength(1);
    for (const record of await stepRecords(rootDir, stdout.text())) {
      expect(record.evidence.requests_trace).toBeUndefined();
      if (record.step !== "nothing-is-sent") expect(record.evidence.http).toBe("http.jsonl");
    }
  });
});

describe("requestsTraceFileName", () => {
  it("never names a page's own chunk, nor any pageAs context's", () =>
    hegel.test((tc) => {
      const chunk = tc.draw(
        gs.sampledFrom(["trace.zip", "hook-before-1.zip", "hook-after-3.zip", "hook-after_step-2-4.zip", "hook-before-12.zip"]),
      );
      const name = tc.draw(gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-", minSize: 1, maxSize: 12 }));
      const requests = requestsTraceFileName(chunk);
      expect(requests).not.toBe(chunk);
      expect(requests.endsWith(".zip")).toBe(true);
      if (isValidContextName(name)) expect(requests).not.toBe(contextFileName(chunk, name));
    }));
});
