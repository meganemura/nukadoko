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

// Responsibility: compat-only scenario e2e
// coverage — `nuka run` actually matching and executing a compat step:
// string/RegExp patterns, a compat-registered custom parameter type, table (as a
// DataTable)/docstring as the trailing positional argument, a throwing step,
// and a Then-position compat step that observes a network write and passes
// anyway (compat has no `mutates` to trust,
// so the old measured Then-position check — now gone entirely — never had a
// declaration to fall back on either way).

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/write" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run: compat step execution", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("compat-run-project");
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

  it("runs string/RegExp patterns + a compat-registered parameter type + table (DataTable) + docstring: result is null, args are positional, exit 0", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/compat-basic.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);

    const [patterns, table, docstring] = records;
    expect(patterns.status).toBe("passed");
    expect(patterns.steps).toHaveLength(3);
    for (const step of patterns.steps) {
      expect(step.status).toBe("passed");
    }

    const firstStepRecord = await readStepRecord(rootDir, patterns.steps[0].record);
    expect(firstStepRecord.result).toBeNull();
    expect(firstStepRecord.args).toEqual(["acme"]);
    // Compat has no `mutates` declaration at all — `null`, never coerced to
    // `false`.
    expect(firstStepRecord.mutates).toBeNull();

    // RegExp capture arrives as a plain string, unlike a typed step's
    // coerced `{int}`.
    const secondStepRecord = await readStepRecord(rootDir, patterns.steps[1].record);
    expect(secondStepRecord.args).toEqual(["3"]);

    // Proves asymmetry #2 closed: the compat-registered `legacyBoolean`
    // parameter type transformed "yes" -> true before matching/args ever
    // reached the glue function.
    const thirdStepRecord = await readStepRecord(rootDir, patterns.steps[2].record);
    expect(thirdStepRecord.args).toEqual([true]);
    expect(thirdStepRecord.result).toBeNull();

    expect(table.status).toBe("passed");
    const tableStepRecord = await readStepRecord(rootDir, table.steps[0].record);
    expect(tableStepRecord.args).toEqual([
      [
        ["name", "age"],
        ["alice", "30"],
        ["bob", "25"],
      ],
    ]);

    expect(docstring.status).toBe("passed");
    const docstringStepRecord = await readStepRecord(rootDir, docstring.steps[0].record);
    expect(docstringStepRecord.args).toEqual(["hello docstring"]);
  });

  it("a throwing compat step fails with a step record and skips the rest of the scenario", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/compat-throw.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");

    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toBe("legacy failure on purpose");
    const failedStepRecord = await readStepRecord(rootDir, record.steps[0].record);
    expect(failedStepRecord.status).toBe("failed");
    expect((failedStepRecord as { error: { message: string } }).error.message).toBe(
      "legacy failure on purpose",
    );
    // A compat step's own throw classifies as "step_error" the same way a
    // typed step's does — `classifyCaughtError` only distinguishes
    // `CompatTimeoutError`/`WorldWriteValidationError` from an ordinary
    // throw, and an ordinary `Error` is neither.
    expect((failedStepRecord as { error: { kind: string } }).error.kind).toBe("step_error");

    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[1].record).toBeNull();
  });

  // A compat step bound in Then position passes exactly like any other
  // step, because the measured Then-position check is gone entirely (this
  // file's own header) — the write is still recorded, just no longer
  // judged. Compat has no `mutates` declaration at all, so under the old
  // check it could never have opted out either way.
  it("a Then-position compat step that observes a network write passes, and the write still lands on observed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/compat-then.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps[0].status).toBe("passed");

    const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
    expect(stepRecord.status).toBe("ok");
    // The measured tally is unchanged by this task (this file's own header)
    // — only whether it fails the step changed.
    expect((stepRecord as { observed: { http_writes: number } }).observed.http_writes).toBe(1);
  });
});
