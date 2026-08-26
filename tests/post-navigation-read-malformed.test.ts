import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: this finding's own defensive parsing.
// tests/post-navigation-read.test.ts's own hand-crafted-record suite
// already pins the gap math and the poll-window boundary; this file pins
// the other half, that a hand-edited or partially-written `record.json` -
// whether the whole file, or just one `actions`/`polls` entry inside it -
// is skipped in place rather than thrown on, and never stops a well-formed
// pair elsewhere in the same project from still being reported.
// `isActionLike`/`isPollLike` are this file's own defensive-parse
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

/** Writes one step record directly under `<rootDir>/.nukadoko/records/
 * steps/<id>/record.json`, the on-disk shape `nuka do`/`nuka run` produce
 * and src/tend/post-navigation-read.ts now reads. `stepRecord` is passed
 * straight through to `JSON.stringify`, so its own `actions`/`polls` (or
 * lack of either) is exactly what that finding sees. Duplicated from
 * tests/post-navigation-read.test.ts's own helper of the same shape rather
 * than imported, since that file exports no helpers of its own to share. */
async function writeStepRecordFile(rootDir: string, id: string, stepRecord: Record<string, unknown>): Promise<void> {
  const dir = path.join(rootDir, ".nukadoko", "records", "steps", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "record.json"), JSON.stringify(stepRecord, null, 2));
}

describe("nuka tend: post-navigation-read, malformed record.json", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("tend-clean-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("skips a record.json that is not valid JSON, without throwing, and still reports a well-formed record beside it", async () => {
    const brokenDir = path.join(rootDir, ".nukadoko", "records", "steps", "broken");
    await mkdir(brokenDir, { recursive: true });
    // Deliberately unparsable - a truncated write, or a hand edit gone
    // wrong.
    await writeFile(path.join(brokenDir, "record.json"), "{not valid json");

    await writeStepRecordFile(rootDir, "well-formed", {
      step: "a step whose record.json parses fine",
      status: "ok",
      actions: [
        { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
        { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
      ],
    });

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.step).toBe("a step whose record.json parses fine");
  });

  it("skips a non-object entry mixed into actions, without throwing, and still reports the valid pair beside it", async () => {
    await writeStepRecordFile(rootDir, "stray-entry", {
      step: "a step whose actions carry one stray, non-object entry",
      status: "ok",
      actions: [
        "not an action object",
        { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
        { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
      ],
    });

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('"click"');
  });

  it("ignores a non-object entry mixed into polls, and a well-formed poll on the same step still excludes its read", async () => {
    await writeStepRecordFile(rootDir, "stray-poll", {
      step: "a step whose polls carry one stray, non-object entry",
      status: "ok",
      actions: [
        { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
        // Starts at 00:00:00.100Z, inside the well-formed poll window
        // below (00:00:00.080Z through 00:00:00.120Z).
        { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
      ],
      polls: ["not a poll object", { at: "2026-01-01T00:00:00.080Z", waited_ms: 40 }],
    });

    const report = await runTendJson(rootDir);
    expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
  });

  it("does not exclude, and does not throw, when a poll's own `at` cannot be parsed as a date", async () => {
    await writeStepRecordFile(rootDir, "unparsable-poll-at", {
      step: "a step whose one poll has an unparsable at",
      status: "ok",
      actions: [
        { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
        { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
      ],
      // Would have covered the read above had `at` been a real
      // timestamp; instead it is skipped, so the read is reported.
      polls: [{ at: "not-a-real-timestamp", waited_ms: 40 }],
    });

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
  });

  it("skips an action pair when one side's own `at` cannot be parsed, and still reports a well-formed pair on the same step", async () => {
    await writeStepRecordFile(rootDir, "unparsable-action-at", {
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
    });

    const report = await runTendJson(rootDir);
    const notes = report.notes.filter((n) => n.code === "post-navigation-read");
    expect(notes).toHaveLength(1);
    // The reported pair is the second, well-formed navigation, not the
    // first, unparsable one.
    const [, gapMsText] = /(\d+)ms after its own/.exec(notes[0]!.message) ?? [];
    expect(Number(gapMsText)).toBe(50);
  });
});
