import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stepRecordDir, stepRecordIds } from "./helpers/fixtures.js";

// Responsibility: retention against a run that is still writing. Two real
// `nuka run` invocations overlap; the newer one ends first.

// The bound is time, not attempts, and sits under the 60 s test timeout: a
// loaded machine can take well over ten seconds to start the first run.
async function until(condition: () => boolean, context: () => string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !condition()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(condition(), context()).toBe(true);
}

describe("two overlapping nuka run processes", () => {
  let rootDir: string;
  const gateEnv = process.env.NUKA_GATE_FILE;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-marker-project");
    process.env.NUKA_GATE_FILE = path.join(rootDir, "gate");
  });

  afterEach(async () => {
    if (gateEnv === undefined) delete process.env.NUKA_GATE_FILE;
    else process.env.NUKA_GATE_FILE = gateEnv;
    await removeTempDir(rootDir);
  });

  it("keeps the older run's records while it is in flight, and after it ends", async () => {
    const slowStderr = createCaptureSink();
    const slow = runCli(["run", "features/slow.feature"], { rootDir, stdout: createCaptureSink(), stderr: slowStderr });
    // The slow run has finished its first scenario's step and is now waiting
    // in the second scenario's step, whose record directory exists from the
    // moment it starts.
    await until(
      () =>
        stepRecordIds(rootDir).length === 2 &&
        stepRecordIds(rootDir).some((id) => existsSync(path.join(stepRecordDir(rootDir, id), "record.json"))),
      () => `the slow run never reached the gate; its stderr:\n${slowStderr.text()}`,
    );
    const slowRecords = stepRecordIds(rootDir);

    const fastStderr = createCaptureSink();
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: fastStderr }),
      fastStderr.text(),
    ).toBe(0);
    expect(fastStderr.text()).not.toContain("retention: removed");
    expect(stepRecordIds(rootDir)).toEqual(expect.arrayContaining(slowRecords));

    await writeFile(path.join(rootDir, "gate"), "");
    expect(await slow, slowStderr.text()).toBe(0);
    // The slow run is older than the fast one and retention.runs is 1, but a
    // run never removes itself.
    expect(slowStderr.text()).not.toContain("retention: removed");
    const records = stepRecordIds(rootDir);
    expect(records).toHaveLength(4);
    expect(records).toEqual(expect.arrayContaining(slowRecords));
  });
});
