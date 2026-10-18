import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a compat World constructor that throws on the first
// scenario must fail that scenario and let the rest of the run finish.
// The defect was an uncaught stack: no scenario record, no summary, and
// the messages export left as the in-progress run file.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: World constructor throw", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("world-constructor-throw-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails that scenario with one setup message, then runs the next and finalizes messages", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/world-throw.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const lines = nonEmptyLines(stdout.text());
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.scenario).toBe("first");
    expect(first.status).toBe("failed");
    expect(first.hooks).toEqual([]);
    expect(first.steps).toEqual([
      {
        line: 4,
        text: "the step runs",
        step: "compat: the step runs",
        status: "failed",
        step_record_id: null,
        record: null,
        error: { kind: null, message: "World setup failed: world constructor boom" },
      },
    ]);
    expect(second.scenario).toBe("second");
    expect(second.status).toBe("passed");
    expect(second.steps).toEqual([
      {
        line: 7,
        text: "the step runs",
        step: "compat: the step runs",
        status: "passed",
        step_record_id: second.steps[0].step_record_id,
        record: `steps/${second.steps[0].step_record_id}`,
        mutates: null,
        observed: { http_reads: null, http_writes: null, processes: null },
      },
    ]);

    const err = stderr.text();
    // One warning, and the failed scenario's own finding names the same error.
    expect(err.match(/^\w+\t[a-z-]+\t.*World setup failed: world constructor boom$/gm)).toEqual([
      "warning\tworld-setup-failed\t-\tWorld setup failed: world constructor boom",
      "failed\tscenario-failed\tfeatures/world-throw.feature:3\tfirst: World setup failed: world constructor boom",
    ]);
    expect(err).toContain("scenario 2/2");
    expect(err).toMatch(/2 scenarios: 1 passed, 1 failed/);
    expect(err).not.toContain("instantiateWorldForPickle");
    expect(err).not.toContain("throw new Error");

    const messagesPath = path.join(rootDir, ".nukadoko", "export", "messages.ndjson");
    expect(existsSync(messagesPath)).toBe(true);
    const messages = await readFile(messagesPath, "utf8");
    expect(messages).toContain('"testRunFinished"');
  });
});
