import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: P5 task spec's own completion conditions 2 and 3 — a
// scenario-scope fixture's own teardown code runs whether the step (hence
// the scenario) passes or fails, and `use()`'s own return value carries
// that outcome back into the fixture's own body, both directions
// (`.claude-team/playwright-native-design.md` 5 節's own conditional-
// cleanup example: only a "passed" outcome destroys what was built).
// Against tests/fixtures/user-fixtures-project, whose `tenant` fixture logs
// one JSON line per lifecycle event to fixture-log.jsonl beside
// nukadoko.config.ts (that file's own header explains why a log file, not
// module state, is what a test reads back). Both scenarios in
// features/teardown.feature run in one `nuka run` invocation (never `:line`
// targeted — that prints its own "Partial run" stderr notice, unrelated to
// this test), so the two scenarios' own log entries are told apart by
// order: the passing scenario always runs first.

interface LogEntry {
  readonly fixture: string;
  readonly phase: string;
  readonly outcome?: string;
}

async function readLog(rootDir: string): Promise<LogEntry[]> {
  const text = await readFile(path.join(rootDir, "fixture-log.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
}

describe("nuka run: scenario-scope fixture teardown", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("user-fixtures-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("tears down with the scenario's own outcome, and only runs the fixture's own conditional cleanup on passed", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/teardown.feature"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    // The whole run fails overall (its second scenario does), even though
    // the first scenario on its own passed — asserted from each scenario's
    // own record below.
    expect(exitCode).toBe(1);

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string; teardown_errors?: unknown });
    expect(records).toHaveLength(2);
    expect(records[0]!.status).toBe("passed");
    expect(records[1]!.status).toBe("failed");
    // Teardown itself never changes a scenario's own status (this task's
    // spec, scope item 6) — nothing in either scenario's own teardown
    // throws, so neither record carries `teardown_errors`.
    expect(records[0]!.teardown_errors).toBeUndefined();
    expect(records[1]!.teardown_errors).toBeUndefined();

    const log = await readLog(rootDir);
    const teardowns = log.filter((entry) => entry.phase === "teardown");
    const cleanups = log.filter((entry) => entry.phase === "cleanup");

    expect(teardowns).toHaveLength(2);
    // Scenario 1 (passing) tears down first, with outcome "passed"; the
    // fixture's own conditional cleanup branch actually ran for it.
    expect(teardowns[0]?.outcome).toBe("passed");
    // Scenario 2 (failing) tears down second, with outcome "failed"; its
    // own fixture instance never reaches the cleanup branch — nukadoko
    // never destroys anything on the fixture's behalf.
    expect(teardowns[1]?.outcome).toBe("failed");
    expect(cleanups).toHaveLength(1);
  });
});
