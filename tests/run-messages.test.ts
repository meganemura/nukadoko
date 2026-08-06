import { existsSync } from "node:fs";
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

// Responsibility: `nuka run` -> messages.ndjson wiring, end to end (m3c-
// messages-emitter spec-b task spec, test item 2). The mapping itself —
// envelope shapes, identity, attachment handling — is already covered by
// src/report/messages/**'s own spec-a tests; this file only proves what
// cli/run.ts adds on top: the default output location, config.messages.
// output overriding it, the `hasPickles` gate, the truncate-on-begin
// semantics for a second run to the same file, and that `end()`'s
// `success` argument agrees with this run's own exit code. Reuses
// run-project (run.test.ts's own fixture, also reused by run-allure.test.ts)
// rather than a new one.

async function readEnvelopes(output: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(output, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function envelopeKeys(envelopes: Record<string, unknown>[]): string[] {
  return envelopes.flatMap((envelope) => Object.keys(envelope));
}

describe("nuka run: messages.ndjson wiring", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes .nukadoko/messages.ndjson by default: every line parses, and every envelope kind this task's spec names is present", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    // stdout/exit code are unchanged by the emitter (this task's spec, item
    // 2) — the same one-record-line assertion run.test.ts's own "runs a
    // pure-step scenario to completion" test makes.
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const stdoutLines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);

    const output = path.join(rootDir, ".nukadoko", "messages.ndjson");
    expect(existsSync(output)).toBe(true);
    const envelopes = await readEnvelopes(output);
    const kinds = envelopeKeys(envelopes);
    for (const expectedKind of [
      "meta",
      "source",
      "gherkinDocument",
      "pickle",
      "testRunStarted",
      "testCase",
      "testRunFinished",
    ]) {
      expect(kinds).toContain(expectedKind);
    }
  });

  it("writes to messages.output instead, root-relative, when config sets it", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        "",
        "export default defineConfig({ messages: { output: \"reports/messages.ndjson\" } });",
        "",
      ].join("\n"),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const output = path.join(rootDir, "reports", "messages.ndjson");
    expect(existsSync(output)).toBe(true);
    // The default location is untouched — the override moves the output,
    // it doesn't add a second copy.
    expect(existsSync(path.join(rootDir, ".nukadoko", "messages.ndjson"))).toBe(false);
  });

  it("writes no messages.ndjson at all for a run that selects zero pickles", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/empty.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(existsSync(path.join(rootDir, ".nukadoko", "messages.ndjson"))).toBe(false);
  });

  it("truncates on a second run to the same output: exactly one testRunStarted, not two", async () => {
    const output = path.join(rootDir, ".nukadoko", "messages.ndjson");

    const first = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(first).toBe(0);

    const second = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(second).toBe(0);

    const envelopes = await readEnvelopes(output);
    const testRunStartedCount = envelopes.filter((envelope) => "testRunStarted" in envelope).length;
    expect(testRunStartedCount).toBe(1);
  });

  it("testRunFinished.success is false, agreeing with the non-zero exit code, for a run with a failing scenario", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/failing.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);

    const output = path.join(rootDir, ".nukadoko", "messages.ndjson");
    const envelopes = await readEnvelopes(output);
    const testRunFinished = envelopes.find(
      (envelope): envelope is { testRunFinished: { success: boolean } } => "testRunFinished" in envelope,
    );
    expect(testRunFinished).toBeDefined();
    expect(testRunFinished!.testRunFinished.success).toBe(false);
  });
});
