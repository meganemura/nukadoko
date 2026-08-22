import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { isMessagesRunOutputFileName } from "../src/report/messages/emitter.js";
import type { ScenarioRecord } from "../src/run/record-types.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: two `nuka run` invocations against the same project,
// launched concurrently, must not corrupt messages.ndjson. The old design
// had both invocations share one truncate-on-begin file
// (src/report/messages/emitter.ts): whichever began second wiped out the
// first's own testRunStarted, and both invocations' own end() still
// appended their own testRunFinished, since nothing truncated the file
// again after either began — an on-disk combination (one testRunStarted,
// two testRunFinished) a single run can never produce.
// features/two-steps-timing.feature's own 300ms step (see that step's own
// file) forces the overlap deterministically: both invocations' own
// begin() calls land well inside that window, long before either one's
// own end() call is reachable. The first test below checks the stable
// path; the second checks the two independent run-id-suffixed files this
// same pair of invocations must also leave behind.

async function readEnvelopes(output: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(output, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function envelopeCount(envelopes: Record<string, unknown>[], kind: string): number {
  return envelopes.filter((envelope) => kind in envelope).length;
}

describe("nuka run: two concurrent invocations against the same project", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("leaves the stable messages.ndjson holding exactly one run's own well-formed stream", async () => {
    const [exitA, exitB] = await Promise.all([
      runCli(["run", "features/two-steps-timing.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
      runCli(["run", "features/two-steps-timing.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
    ]);

    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    const output = path.join(rootDir, ".nukadoko", "export", "messages.ndjson");
    const envelopes = await readEnvelopes(output);

    // The exact shape a single run always produces, and only a single
    // run: corruption from two invocations sharing one file changes at
    // least one of these three counts (this file's own header explains
    // which way, and why).
    expect(envelopeCount(envelopes, "testRunStarted")).toBe(1);
    expect(envelopeCount(envelopes, "testRunFinished")).toBe(1);
    expect(envelopeCount(envelopes, "testCase")).toBe(1);
  });

  it("also leaves each run's own run-id-suffixed file behind, independently well-formed", async () => {
    const stdoutA = createCaptureSink();
    const stdoutB = createCaptureSink();

    const [exitA, exitB] = await Promise.all([
      runCli(["run", "features/two-steps-timing.feature"], { rootDir, stdout: stdoutA, stderr: createCaptureSink() }),
      runCli(["run", "features/two-steps-timing.feature"], { rootDir, stdout: stdoutB, stderr: createCaptureSink() }),
    ]);
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    const recordA = JSON.parse(stdoutA.text().trim()) as ScenarioRecord;
    const recordB = JSON.parse(stdoutB.text().trim()) as ScenarioRecord;
    expect(recordA.run_id).not.toBe(recordB.run_id);

    const output = path.join(rootDir, ".nukadoko", "export", "messages.ndjson");
    const exportDir = path.dirname(output);
    const runFiles = readdirSync(exportDir).filter((name) => isMessagesRunOutputFileName(output, name));

    expect(runFiles.sort()).toEqual(
      [`messages.${recordA.run_id}.ndjson`, `messages.${recordB.run_id}.ndjson`].sort(),
    );

    for (const runFile of runFiles) {
      const envelopes = await readEnvelopes(path.join(exportDir, runFile));
      expect(envelopeCount(envelopes, "testRunStarted")).toBe(1);
      expect(envelopeCount(envelopes, "testRunFinished")).toBe(1);
      expect(envelopeCount(envelopes, "testCase")).toBe(1);
    }
  });
});
