import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: this finding's own defensive parsing.
// tests/post-navigation-read.test.ts's own hand-crafted-record suite
// already pins the gap math and the poll-window boundary; this file pins
// the other half, that a hand-edited or partially-written `actions`/`polls`
// entry is skipped in place rather than thrown on, and never stops a
// well-formed pair elsewhere on the same step record from still being
// reported. `isActionLike`/`isPollLike` are this file's own defensive-parse
// convention (src/tend/post-navigation-read.ts's own header): neither is
// exported, so these are exercised only through `findPostNavigationReads`
// itself, via `nuka tend --json`, the same public surface every other test
// in this suite already goes through.

interface Report {
  notes: { code: string; message: string; step?: string }[];
}

async function runTendJson(rootDir: string): Promise<Report> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.text()) as Report;
}

const COMMIT = "0".repeat(40);

/** Matches tests/post-navigation-read.test.ts's own `buildRecord` shape
 * closely enough for src/tend/record-parse.ts to accept it (duplicated
 * here rather than imported, since that file exports no helpers of its own
 * to share). */
function buildRecord(options: { stepText: string; stepRecord: Record<string, unknown> }): string {
  const { stepText, stepRecord } = options;
  return [
    "---",
    "run_id: run-synthetic",
    `commit: ${COMMIT}`,
    "feature: features/does-not-exist.feature",
    "ran_at: 2026-01-01T00:00:00.000Z",
    "accepted_at: 2026-01-01T00:00:00.000Z",
    "environment: default",
    "browser: none",
    "scenarios:",
    "  - name: a synthetic scenario",
    "    line: 2",
    "    scenario_record_id: scn-synthetic",
    "---",
    "",
    "# Synthetic: green at 0000000",
    "",
    "## The scenario as it ran",
    "",
    "```gherkin",
    "Feature: Synthetic",
    "  Scenario: a synthetic scenario",
    `    Given ${stepText}`,
    "```",
    "",
    "## What the tool measured",
    "",
    "### a synthetic scenario (line 2)",
    "",
    `#### ${stepText}`,
    "",
    "```json",
    JSON.stringify(stepRecord, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("nuka tend: post-navigation-read, malformed actions/polls", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("tend-clean-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("skips a non-object entry mixed into actions, without throwing, and still reports the valid pair beside it", async () => {
    await writeFile(
      path.join(rootDir, "stray-entry.2026-01-01-0000000.md"),
      buildRecord({
        stepText: "a step whose actions carry one stray, non-object entry",
        stepRecord: {
          step: "a step whose actions carry one stray, non-object entry",
          status: "ok",
          actions: [
            "not an action object",
            { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
            { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
          ],
        },
      }),
    );

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('"click"');
  });

  it("ignores a non-object entry mixed into polls, and a well-formed poll on the same step still excludes its read", async () => {
    await writeFile(
      path.join(rootDir, "stray-poll.2026-01-01-0000000.md"),
      buildRecord({
        stepText: "a step whose polls carry one stray, non-object entry",
        stepRecord: {
          step: "a step whose polls carry one stray, non-object entry",
          status: "ok",
          actions: [
            { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
            // Starts at 00:00:00.100Z, inside the well-formed poll window
            // below (00:00:00.080Z through 00:00:00.120Z).
            { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
          ],
          polls: ["not a poll object", { at: "2026-01-01T00:00:00.080Z", waited_ms: 40 }],
        },
      }),
    );

    const report = await runTendJson(rootDir);
    expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
  });

  it("does not exclude, and does not throw, when a poll's own `at` cannot be parsed as a date", async () => {
    await writeFile(
      path.join(rootDir, "unparsable-poll-at.2026-01-01-0000000.md"),
      buildRecord({
        stepText: "a step whose one poll has an unparsable at",
        stepRecord: {
          step: "a step whose one poll has an unparsable at",
          status: "ok",
          actions: [
            { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
            { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
          ],
          // Would have covered the read above had `at` been a real
          // timestamp; instead it is skipped, so the read is reported.
          polls: [{ at: "not-a-real-timestamp", waited_ms: 40 }],
        },
      }),
    );

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
  });

  it("skips an action pair when one side's own `at` cannot be parsed, and still reports a well-formed pair on the same step", async () => {
    await writeFile(
      path.join(rootDir, "unparsable-action-at.2026-01-01-0000000.md"),
      buildRecord({
        stepText: "a step whose first navigation has an unparsable at",
        stepRecord: {
          step: "a step whose first navigation has an unparsable at",
          status: "ok",
          actions: [
            // Type-shaped (isActionLike passes), but `at` is not a real
            // timestamp, so the gap from it can never be computed.
            { method: "goto", at: "not-a-real-timestamp", ms: 50 },
            { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
            { method: "goto", at: "2026-01-01T00:00:05.000Z", ms: 50 },
            { method: "click", at: "2026-01-01T00:00:05.100Z", ms: 5 },
          ],
        },
      }),
    );

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
    // The reported pair is the second, well-formed navigation, not the
    // first, unparsable one.
    const [, gapMsText] = /(\d+)ms after its own/.exec(notes[0]!.message) ?? [];
    expect(Number(gapMsText)).toBe(50);
  });
});
