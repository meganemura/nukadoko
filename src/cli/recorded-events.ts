import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EVENTS_LATE_FILE_NAME, EVENTS_WORLD_FILE_NAME } from "../context/events-file.js";
import type { EventsProducer } from "../context/events-read.js";
import type { RunDocument, RunEventsLate } from "../record/run-result.js";
import { runRelativeDir, stepRecordRelativeDir } from "../record/state-layout.js";
import type { StepRecord } from "../record/types.js";

// Responsibility: where a finished step record's execution events are, so
// that a claim step under `nuka do --use` reads them
// (src/context/events-read.ts, "recorded"): the record's directory with
// its `events.jsonl` and `events-late.jsonl`, whether the late lines are
// all there, and the world's copy, whose kinds count as reported.
// Boundary: reads a record's place on disk and nothing a line says.
//
// A `nuka do` record names its late lines itself (`events_late`), since
// it is written after its world stops. A `nuka run` record is written
// before, so its run's `run.json` names them, and the world whose copy
// holds the kinds. A late file whose count no record names (`run.json`
// not written, or a record an earlier build wrote) may be cut short, so
// it counts as truncated: an absence then stays unjudged rather than hold
// on lines that may not all be there. A record with no late file and no
// count had none, or its world never stopped; either way its own lines
// say whether they are whole. A program that writes a request's line after
// the work inside it (docs/execution-events.md "Inside first") puts every
// line a whole reading needs before the line that makes it whole.

function readRun(rootDir: string, stateDir: string, runId: string): RunDocument | null {
  try {
    return JSON.parse(readFileSync(path.join(rootDir, runRelativeDir(stateDir, runId), "run.json"), "utf8")) as RunDocument;
  } catch {
    return null;
  }
}

/** Whether a reading of the late file can miss lines: past the cap, or
 * not written, or with no count to say. */
function lateMayMiss(late: RunEventsLate | undefined, dir: string): boolean {
  if (late === undefined) return existsSync(path.join(dir, EVENTS_LATE_FILE_NAME));
  return late.truncated === true || (late.lines > 0 && late.file === null);
}

/** The producer a reading of `record`'s execution events reads. */
export function recordedEventsProducer(rootDir: string, stateDir: string, record: StepRecord): EventsProducer {
  const dir = path.join(rootDir, stepRecordRelativeDir(stateDir, record.run_id, record.step_record_id));
  const run = record.run_id === null ? null : readRun(rootDir, stateDir, record.run_id);
  const scenario = run?.scenarios.find((entry) => entry.steps.some((step) => step.step_record_id === record.step_record_id));
  const step = scenario?.steps.find((entry) => entry.step_record_id === record.step_record_id);
  const of = { step_record_id: record.step_record_id, step: record.step, line: step?.line ?? null };
  const slice = record.observed.events;
  // A world nukadoko serves slices every step's events when its program
  // file names {events}, and gives every step a program log slice.
  if (slice === null) return { source: "unread", of, gap: "world-unread" };
  if (slice === undefined) return { source: "unread", of, gap: record.observed.program_log === undefined || record.observed.program_log === null ? "world-unread" : "inlet-unnamed" };
  if (record.run_id === null) {
    const world = path.join(dir, "world", EVENTS_WORLD_FILE_NAME);
    return { source: "recorded", of, dir, slice, lateTruncated: lateMayMiss(record.events_late, dir), ...(existsSync(world) ? { world } : {}) };
  }
  const copy =
    scenario === undefined ? undefined : run?.worlds?.find((world) => world.name === scenario.environment && world.tree === (scenario.world ?? "head"))?.events?.file;
  const world = copy === undefined || copy === null ? undefined : path.join(rootDir, runRelativeDir(stateDir, record.run_id), copy);
  return { source: "recorded", of, dir, slice, lateTruncated: lateMayMiss(step?.events_late, dir), ...(world === undefined ? {} : { world }) };
}
