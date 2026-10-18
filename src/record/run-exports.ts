import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRelativeDir } from "./state-layout.js";

// Responsibility: which export files were written for one run, kept as an
// append-only manifest in the run's own directory,
// `<stateDir>/runs/<run_id>/` (src/record/state-layout.ts). `nuka report`
// notes each file it writes under the state directory for one of this
// project's runs (src/cli/report.ts); retention (src/record/retention.ts)
// reads the manifest to remove a run's export output together with its
// records, and a second render of the same run reads it to replace the
// first.
//
// Why a file, and why append-only: a run directory is what retention,
// CI uploads, and `nuka report` share, and a render can happen in a later
// process, long after the run. `appendFileSync` opens with O_APPEND, so two
// renders at once land whole lines, in some order, and order does not
// matter to a reader that treats the file as a set.
//
// Why the names are recorded although they are derived: a result's name
// comes from the run id, the scenario, and the environment
// (src/report/allure/writer.ts's `stableNames`), but a hash names no run a
// reader can see, and a Markdown or messages file has whatever name
// `--out` gave it. The manifest is the one list retention can read.
//
// A render that replaces its earlier render first removes the earlier
// files and their lines (`forgetExports`), so the manifest holds each file
// once however often the run is rendered. That one rewrite goes through a
// temporary file and a rename, so a reader never sees half of it.
//
// Root-relative paths, not results-dir-relative: one run can be rendered
// into more than one directory, and a removal must target where each file
// actually is.
//
// Not a run record. The manifest carries no status, no timing, and no
// scenario ids; those live in the run's run.json.

export const RUN_EXPORTS_FILE_NAME = "exports";

export function runDir(rootDir: string, stateDir: string, runId: string): string {
  return path.join(rootDir, runRelativeDir(stateDir, runId));
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
 * leaves its own `runs/<run_id>/` behind. */
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

/** Removes every line of the manifest that names one of
 * `relativePaths`. A missing manifest stays missing. */
export function forgetExports(filePath: string, relativePaths: ReadonlySet<string>): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const kept = content.split("\n").filter((line) => line.length > 0 && !relativePaths.has(line));
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, kept.map((line) => `${line}\n`).join(""));
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
