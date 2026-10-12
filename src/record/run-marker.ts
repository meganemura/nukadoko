import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDir } from "./run-exports.js";

// Responsibility: the completion marker one `nuka run` leaves in its own
// `records/runs/<run_id>/` when it ends, holding the run's verdict and its
// end time. Retention reads it to tell a finished run from one that is still
// writing, and `nuka accept` reads it for the verdict.
//
// Why a marker and not the scenario records: a scenario record says how one
// scenario went. It cannot say the run is over (a later scenario may still
// be waiting to write its own), and it cannot say a run-scope hook failed
// after every scenario passed, which is what makes the run exit 1. Only the
// invocation that ran everything knows both, so it writes the one file that
// says so, last.
//
// A run that was killed, or written before this file existed, has no
// marker. Both readers treat that as "not proven finished", never as
// "failed": retention keeps such a run until it is older than
// `retention.adHocDays`, and `nuka accept` refuses it.

export const RUN_MARKER_FILE_NAME = "complete.json";

export interface RunMarker {
  readonly verdict: "passed" | "failed";
  /** ISO 8601 time the run ended. */
  readonly finished_at: string;
}

export function runMarkerPath(rootDir: string, stateDir: string, runId: string): string {
  return path.join(runDir(rootDir, stateDir, runId), RUN_MARKER_FILE_NAME);
}

export function writeRunMarker(
  rootDir: string,
  stateDir: string,
  runId: string,
  verdict: RunMarker["verdict"],
  finishedAt: Date,
): void {
  const filePath = runMarkerPath(rootDir, stateDir, runId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const marker: RunMarker = { verdict, finished_at: finishedAt.toISOString() };
  writeFileSync(filePath, `${JSON.stringify(marker)}\n`);
}

/** The run's marker, or `null` when it has none or the file cannot be read
 * as one. */
export function readRunMarker(rootDir: string, stateDir: string, runId: string): RunMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runMarkerPath(rootDir, stateDir, runId), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const { verdict, finished_at: finishedAt } = parsed as Record<string, unknown>;
    if ((verdict !== "passed" && verdict !== "failed") || typeof finishedAt !== "string") return null;
    return { verdict, finished_at: finishedAt };
  } catch {
    return null;
  }
}
