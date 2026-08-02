import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run` end to end against run-project — a pure-step
// fixture (no browser, no HTTP server) covering matching/skip/record
// mechanics on their own (m1-run task spec, scope item 4). Browser evidence,
// `--session` propagation, and secret redaction each get their own file
// (run-browser.test.ts, run-session.test.ts, run-secrets.test.ts) since they
// need their own fixture project and/or a real server or chromium.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("nuka run", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs a pure-step scenario to completion: record + receipts + JSONL stdout + exit 0", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");

    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.feature).toBe("features/passing.feature");
    expect(record.scenario).toBe("create and check a thing");
    expect(record.line).toBe(3);
    expect(record.status).toBe("passed");
    expect(record.environment).toBe("default");
    expect(record.session).toBeNull();
    expect(record.steps).toHaveLength(2);
    for (const step of record.steps) {
      expect(step.status).toBe("passed");
      expect(typeof step.receipt).toBe("string");
      expect(step.error).toBeUndefined();
    }
    expect(record.evidence.dir).toBe(path.join(".nukadoko", "scenarios", record.scenario_id));
    expect(record.evidence.screenshots).toEqual([]);
    expect(record.evidence.trace).toBeUndefined();

    const recordPath = path.join(rootDir, record.evidence.dir, "record.json");
    expect(existsSync(recordPath)).toBe(true);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);

    for (const step of record.steps) {
      const receipt = await readReceipt(rootDir, step.receipt);
      expect(receipt.status).toBe("ok");
      expect(receipt.kind).toBe("run");
      expect(receipt.scenario).toBe(record.scenario_id);
      expect(receipt.environment).toBe("default");
      expect(receipt.session).toBeNull();
      // A pure step makes no network calls at all (this task's spec,
      // decision 3): `observed` is still always present, at zero.
      expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 0 });
    }
  });

  it("skips every step after one fails, recording each step's own status; exit 1", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/failing.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(3);

    const [first, second, third] = record.steps;
    expect(first.status).toBe("passed");
    expect(typeof first.receipt).toBe("string");

    expect(second.status).toBe("failed");
    expect(typeof second.receipt).toBe("string");
    expect(second.error.message).toBe("operation failed on purpose");
    const failedReceipt = await readReceipt(rootDir, second.receipt);
    expect(failedReceipt.status).toBe("failed");
    expect((failedReceipt as { error: { message: string } }).error.message).toBe(
      "operation failed on purpose",
    );

    expect(third.status).toBe("skipped");
    expect(third.receipt).toBeNull();
    expect(third.error).toBeUndefined();

    // Only the two steps that actually began execution wrote a receipt.
    const receiptsDir = path.join(rootDir, ".nukadoko", "receipts");
    expect(await readdir(receiptsDir)).toHaveLength(2);
  });

  it("an undefined step gets no receipt and fails the scenario, naming the unmatched text", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/undefined.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("undefined");
    expect(record.steps[1].receipt).toBeNull();
    expect(record.steps[1].error.message).toContain(
      'No step definition matches "this text matches no step definition at all"',
    );
    expect(record.steps[1].error.message).toContain("nuka scaffold");
  });

  it("an ambiguous step gets no receipt and names every step that matched", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/ambiguous.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("ambiguous");
    expect(record.steps[0].receipt).toBeNull();
    expect(record.steps[0].error.message).toContain("ambiguous-a");
    expect(record.steps[0].error.message).toContain("ambiguous-b");
  });

  // Then-position measured enforcement (a declared-mutating step's *actual*
  // network writes, not the declaration itself) needs a real HTTP server, so
  // it lives in its own file — tests/observed.test.ts — following this
  // file's own split-by-evidence-type convention (see this file's header
  // comment).

  it("binds a table to the one unconsumed key; a second scenario violates that rule and still writes a failed receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/table.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);

    const [ok, bad] = records;
    expect(ok.scenario).toBe("a table binds successfully");
    expect(ok.status).toBe("passed");
    const okReceipt = await readReceipt(rootDir, ok.steps[0].receipt);
    expect(okReceipt.args).toEqual({
      a: "a",
      rest: [
        ["col1", "col2"],
        ["x", "y"],
      ],
    });

    expect(bad.scenario).toBe("a table fails to bind");
    expect(bad.status).toBe("failed");
    expect(bad.steps[0].status).toBe("failed");
    expect(typeof bad.steps[0].receipt).toBe("string");
    expect(bad.steps[0].error.message).toContain("2 args keys are left unconsumed");
    expect(bad.steps[0].error.message).toContain("rest");
    expect(bad.steps[0].error.message).toContain("extra");
    const badReceipt = await readReceipt(rootDir, bad.steps[0].receipt);
    expect(badReceipt.status).toBe("failed");
    expect((badReceipt as { args: unknown }).args).toEqual({ a: "a" });
  });

  it(":line selects only the matching scenario in a two-scenario file", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.scenario).toBe("second scenario");
    expect(record.line).toBe(6);
    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect((receipt as { result: { label: string } }).result.label).toBe("second");

    const scenariosDir = path.join(rootDir, ".nukadoko", "scenarios");
    expect(await readdir(scenariosDir)).toHaveLength(1);
  });

  it("an invalid :line is a setup failure: stderr + exit 1, nothing written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/lines.feature:999"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("999");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });

  it("a missing feature file is a setup failure: stderr + exit 1, nothing written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/does-not-exist.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("does-not-exist.feature");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });

  it("--tag is gone: yargs reports it as an unknown argument (design decision 2026-08-02, --tag removed)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["run", "features/passing.feature", "--tag", "issue-42"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(stderr.text()).toContain("tag");
  });
});
