import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2b-compat-execution task spec's compat-only scenario e2e
// coverage — `nuka run` actually matching and executing a compat step
// (closing m2a-compat-registry's two temporary asymmetries): string/RegExp
// patterns, a compat-registered custom parameter type, table (as a
// DataTable)/docstring as the trailing positional argument, a throwing step,
// and Then-position measured enforcement against a compat step.

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

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
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
    expect(stderr.text()).toBe("");

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);

    const [patterns, table, docstring] = records;
    expect(patterns.status).toBe("passed");
    expect(patterns.steps).toHaveLength(3);
    for (const step of patterns.steps) {
      expect(step.status).toBe("passed");
    }

    const firstReceipt = await readReceipt(rootDir, patterns.steps[0].receipt);
    expect(firstReceipt.result).toBeNull();
    expect(firstReceipt.args).toEqual(["acme"]);
    // m3a-receipt-kinds task spec, decision 3: compat has no `mutates`
    // declaration at all — `null`, never coerced to `false`.
    expect(firstReceipt.mutates).toBeNull();

    // RegExp capture arrives as a plain string, unlike a typed step's
    // coerced `{int}`.
    const secondReceipt = await readReceipt(rootDir, patterns.steps[1].receipt);
    expect(secondReceipt.args).toEqual(["3"]);

    // Proves asymmetry #2 closed: the compat-registered `legacyBoolean`
    // parameter type transformed "yes" -> true before matching/args ever
    // reached the glue function.
    const thirdReceipt = await readReceipt(rootDir, patterns.steps[2].receipt);
    expect(thirdReceipt.args).toEqual([true]);
    expect(thirdReceipt.result).toBeNull();

    expect(table.status).toBe("passed");
    const tableReceipt = await readReceipt(rootDir, table.steps[0].receipt);
    expect(tableReceipt.args).toEqual([
      [
        ["name", "age"],
        ["alice", "30"],
        ["bob", "25"],
      ],
    ]);

    expect(docstring.status).toBe("passed");
    const docstringReceipt = await readReceipt(rootDir, docstring.steps[0].receipt);
    expect(docstringReceipt.args).toEqual(["hello docstring"]);
  });

  it("a throwing compat step fails with a receipt and skips the rest of the scenario", async () => {
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
    const failedReceipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(failedReceipt.status).toBe("failed");
    expect((failedReceipt as { error: { message: string } }).error.message).toBe(
      "legacy failure on purpose",
    );
    // m3a-receipt-kinds task spec: a compat step's own throw classifies as
    // "step_error" the same way a typed step's does — `classifyCaughtError`
    // only distinguishes `CompatTimeoutError`/`WorldWriteValidationError`
    // from an ordinary throw, and an ordinary `Error` is neither.
    expect((failedReceipt as { error: { kind: string } }).error.kind).toBe("step_error");

    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[1].receipt).toBeNull();
  });

  it("a Then-position compat step that observes a network write fails (runtime enforcement applies to compat too)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/compat-then.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("Then must not mutate");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.status).toBe("failed");
    expect((receipt as { observed: { http_writes: number } }).observed.http_writes).toBe(1);
    // m3a-receipt-kinds task spec: the Then-position demotion classifies a
    // compat step's receipt exactly like a typed step's (finishExecutedStep
    // applies uniformly regardless of kind).
    expect((receipt as { error: { kind: string } }).error.kind).toBe("then_mutated");
  });
});
