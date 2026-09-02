import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: which export files one `nuka run` invocation wrote, kept
// as an append-only manifest under `<stateDir>/records/runs/<run_id>/`.
// Retention (src/record/retention.ts) reads it to remove a run's own
// Allure output together with its records; nothing else does.
//
// Why a file, and why append-only: under `--concurrency <n>` the Allure
// files are written by worker processes (src/run/run-worker-entry.ts owns
// its own emitter), so the parent that decides what to remove never sees
// their names in memory. Each writer appends one root-relative path per
// line as it writes the file; `appendFileSync` opens with O_APPEND, so
// concurrent appends from several workers land whole, in some order, and
// order does not matter to a reader that treats the file as a set.
//
// Why the names cannot be derived instead: an attachment's file name is
// chosen by allure-js-commons and written into the result's own `source`
// field before the writer sees it, so a run cannot stamp its id into the
// name without breaking the link from result to attachment. Recording the
// name at write time is the only way the run keeps ownership of it.
//
// Root-relative paths, not results-dir-relative: `allure.resultsDir` can
// be changed between the run that wrote a file and the run that removes
// it, and a removal must target where the file actually is.
//
// Not a run record. The manifest carries no status, no timing, and no
// scenario ids; those already live on every scenario record's own
// `run_id`/`started_at`/`steps[]`, which is what retention groups by.

export const RUN_EXPORTS_FILE_NAME = "exports";

export function runDir(rootDir: string, stateDir: string, runId: string): string {
  return path.join(rootDir, stateDir, "records", "runs", runId);
}

export function runExportsManifestPath(rootDir: string, stateDir: string, runId: string): string {
  return path.join(runDir(rootDir, stateDir, runId), RUN_EXPORTS_FILE_NAME);
}

export interface ExportsManifest {
  /** Appends one root-relative line for `absolutePath`. Synchronous, so
   * the Allure writer (synchronous by allure-js-commons' own `Writer`
   * contract) can call it inline. */
  note(absolutePath: string): void;
}

/** Creates the manifest's directory up front, so the first `note` call
 * has nowhere to fail, and so a run that wrote no export file at all still
 * leaves its own `records/runs/<run_id>/` behind for retention to date. */
export function createExportsManifest(filePath: string, rootDir: string): ExportsManifest {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    note(absolutePath: string): void {
      appendFileSync(filePath, `${path.relative(rootDir, absolutePath)}\n`);
    },
  };
}

/** Every distinct root-relative path the manifest lists, in first-seen
 * order. A missing manifest reads as an empty list: a run that wrote no
 * export file (or a run older than this manifest existed) owns nothing
 * under export/. */
export function readExportsManifest(filePath: string): string[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    if (line.length > 0) {
      seen.add(line);
    }
  }
  return [...seen];
}
