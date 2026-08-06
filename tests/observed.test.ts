import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: measured mutates end to end against tests/fixtures/
// observed-project — a real local http server, exercised through both
// `nuka do` and `nuka run` (this task's spec's m2pre-observed spec, scope
// item 6): the request-side `{1, 1}` tally landing on a receipt, and — since
// t2-trust-declaration — that a declared `mutates: false` step's own
// occurrence is never failed by what it actually observed writing, whether
// it is bound in Then position or run under a `policy: "read-only"`
// environment; `observed` still records the write either way, only `status`
// stopped reacting to it. Page-side (chromium) observation has its own test
// in browser-evidence.test.ts, following that file's existing convention for
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
    // `:3` is a partial run of this two-scenario feature, so that notice is
    // expected on stderr — asserted as "one line, and it is that one"
    // rather than by its exact wording, which this test has no stake in:
    // what it is checking is that nothing *else* warned.
    expect(
      stripRunProgressLines(stderr.text())
        .split("\n")
        .filter((line) => line.length > 0),
    ).toHaveLength(1);
    expect(stderr.text()).toContain("Partial run:");
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[1].status).toBe("passed");
  });

  // Before t2-trust-declaration this scenario failed: a Then-position step's
  // own measured write demoted its receipt regardless of what it declared,
  // and skipped the rest of the scenario. The step here now declares
  // `mutates: false` (tests/fixtures/observed-project/features/steps/
  // a-write-happens.ts) — nukadoko trusts that declaration instead of the
  // measurement, so the whole scenario passes and the following step, which
  // used to be skipped, actually runs.
  it("nuka run: a Then-position step declared mutates: false passes even though it observes a write, and the rest of the scenario keeps running", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/then-position.feature:7"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(3);

    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("passed");
    expect(record.steps[2].status).toBe("passed");

    // The write is still measured and still lands on the receipt (this
    // task's spec, decision 5: the record is unchanged) — only whether it
    // fails the step changed.
    const receipt = JSON.parse(
      await readFile(
        path.join(rootDir, ".nukadoko", "receipts", record.steps[1].receipt, "receipt.json"),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("ok");
    expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 1 });
  });

  // Before t2-trust-declaration this was the "lie backstop": a declared
  // `mutates: false` step that actually POSTed under a read-only
  // environment used to be demoted to `status: "failed"`. nukadoko now
  // trusts the declaration instead of measuring against it, so this
  // succeeds — the write still lands on `observed`, unredacted and
  // unchanged, for a report to catch the wrong declaration after the fact.
  it("read-only environment: a declared mutates:false step that actually POSTs passes, and the write still lands on observed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "read-only-lie", "--args", "{}", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 1 });
  });

  // `nuka run` against a read-only environment (this task's spec, decision
  // 3): the gap the previous slice surfaced — `nuka run` never looked at
  // `policy` at all — closed the same way `nuka do` already handles it. A
  // declared `mutates: true` step is still refused before it ever runs
  // (t2-trust-declaration task spec keeps this half unchanged); a declared
  // `mutates: false` lie is no longer backstopped — see the test below.
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

  // Before t2-trust-declaration this was `nuka run`'s own version of the
  // lie backstop above, and failed the same way. It now passes for the same
  // reason: the declaration is trusted over the measurement.
  it("nuka run: a step declared mutates:false that actually writes passes under a read-only environment, and the write still lands on observed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/read-only-policy.feature:7", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(1);

    expect(record.steps[0].status).toBe("passed");

    const receipt = JSON.parse(
      await readFile(
        path.join(rootDir, ".nukadoko", "receipts", record.steps[0].receipt, "receipt.json"),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("ok");
    expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 1 });
  });
});
