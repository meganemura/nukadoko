import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: measured mutates end to end against tests/fixtures/
// observed-project — a real local http server, exercised through both
// `nuka do` and `nuka run` (this task's spec's m2pre-observed spec, scope
// item 6): the request-side `{1, 1}` tally landing on a receipt, Then-
// position measured enforcement (GET passes, POST fails and skips the
// rest), and the read-only environment's backstop against a declared
// `mutates: false` lie. Page-side (chromium) observation has its own test in
// browser-evidence.test.ts, following that file's existing convention for
// browser-path evidence.

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/ok") {
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

describe("measured mutates: request-side observed counts", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("observed-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}", environments: { readonly: { policy: "read-only" } } });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("nuka do: one GET and one POST land on the receipt as observed {1, 1}", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "hit-get-and-post", "--args", "{}"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.observed).toEqual({ http_reads: 1, http_writes: 1 });
  });

  it("nuka run: a Then-position step observing only reads passes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/then-position.feature:3"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[1].status).toBe("passed");
  });

  it("nuka run: a Then-position step observing a write fails, measured, and skips the rest", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/then-position.feature:7"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(3);

    expect(record.steps[0].status).toBe("passed");

    expect(record.steps[1].status).toBe("failed");
    // Unlike the old declare-based rejection, the step's execution actually
    // began, so it gets a real receipt id, not `null` (this task's spec,
    // decision 4).
    expect(typeof record.steps[1].receipt).toBe("string");
    expect(record.steps[1].error.message).toContain("bound in Then position");
    expect(record.steps[1].error.message).toContain("observed 1 network write");

    // m3a-receipt-kinds task spec: a Then-position step measured writing
    // classifies as "then_mutated", distinct from "read_only_violation"
    // (the other measured demotion, keyed off environment policy instead).
    const failedReceipt = JSON.parse(
      await readFile(
        path.join(rootDir, ".nukadoko", "receipts", record.steps[1].receipt, "receipt.json"),
        "utf8",
      ),
    );
    expect(failedReceipt.error.kind).toBe("then_mutated");

    expect(record.steps[2].status).toBe("skipped");
    expect(record.steps[2].receipt).toBeNull();
  });

  it("read-only environment: a declared mutates:false step that actually POSTs gets a failed receipt (the lie backstop)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "read-only-lie", "--args", "{}", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("failed");
    expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 1 });
    expect(receipt.error.message).toContain("read-only-lie");
    expect(receipt.error.message).toContain("readonly");
    expect(receipt.error.message).toContain("read-only");
    // m3a-receipt-kinds task spec: the measured read-only backstop
    // classifies as "read_only_violation", distinct from "then_mutated".
    expect(receipt.error.kind).toBe("read_only_violation");
  });

  // `nuka run` against a read-only environment (this task's spec, decision
  // 3): the gap the previous slice surfaced — `nuka run` never looked at
  // `policy` at all — closed the same way `nuka do` already handles it,
  // generalized to "declared-mutates refusal is a never-began outcome; a
  // declared-false lie is a measured backstop".
  it("nuka run: a declared-mutating step is refused before it runs in a read-only environment; the rest of the scenario is skipped", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/read-only-policy.feature:3", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);

    expect(record.steps[0].status).toBe("failed");
    // Never began: no receipt was written for it (docs/spec.md: "an
    // execution that never began must not be citable").
    expect(record.steps[0].receipt).toBeNull();
    expect(record.steps[0].error.message).toContain("declared-mutating-step");
    expect(record.steps[0].error.message).toContain("mutates state");
    expect(record.steps[0].error.message).toContain("readonly");
    expect(record.steps[0].error.message).toContain("read-only");

    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[1].receipt).toBeNull();
  });

  it("nuka run: a step declared mutates:false that actually writes gets a failed receipt under a read-only environment (the lie backstop)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/read-only-policy.feature:7", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);

    expect(record.steps[0].status).toBe("failed");
    // Unlike the declared-mutates refusal above, this step's execution
    // actually began, so it gets a real receipt id, not `null`.
    expect(typeof record.steps[0].receipt).toBe("string");
    expect(record.steps[0].error.message).toContain("observed 1 network write");
    expect(record.steps[0].error.message).toContain("readonly");
    expect(record.steps[0].error.message).toContain("read-only");

    const receipt = JSON.parse(
      await readFile(
        path.join(rootDir, ".nukadoko", "receipts", record.steps[0].receipt, "receipt.json"),
        "utf8",
      ),
    );
    expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 1 });
    // m3a-receipt-kinds task spec: `nuka run`'s own measured read-only
    // backstop classifies the same way cli/do.ts's does.
    expect(receipt.error.kind).toBe("read_only_violation");
  });
});
