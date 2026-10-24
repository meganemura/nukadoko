import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { readOwnedExports } from "../record/run-exports.js";
import { removeStaleTreeRegistrations } from "../run/base-run.js";
import { allureResultsRelativeDir, doRelativeDir, isInsideDir, runsRelativeDir } from "../record/state-layout.js";
import type { Finding } from "../finding/finding.js";
import { formatEnvelope, refuse } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka clean`'s actual work — delete the disposable half
// of the state directory (docs/spec.md "Artifacts": Measurement and
// Export), kept out of run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts, cli/check.ts). This is the
// whole-category operation; the routine, bounded removal is retention
// (src/record/retention.ts), which `nuka run` applies on its own at the
// end of every run. `clean` stays for what retention deliberately never
// touches: everything at once, a results directory that predates the
// per-run manifests retention needs.
//
// The measurement directories, `runs/<run_id>/` and `do/<id>/`, come from
// src/record/state-layout.ts, the same place every writer gets them.
// Under `export/`, a clean removes what nukadoko wrote and nothing else:
// the files a run's exports manifest names (src/record/run-exports.ts), and
// everything in `export/allure-results/`, the default directory `nuka
// report --format allure` writes into, which also takes the results of a
// copied run no manifest names. Every other entry stays: an Allure history
// file (`allure-history.jsonl`, which the allurerc.mjs `nuka init --allure`
// writes names), an `allure generate` report, or any file a person put
// there. The alternative refused: emptying all of `export/` but one
// hard-coded name, which deleted a configured history path or a generated
// report nukadoko never wrote. A report written with `--out` outside the
// state directory is the caller's file, not this tool's to delete.
//
// `export/allure-results/` is removed and immediately recreated empty,
// mirroring cli/init.ts's own reasoning for creating it that way in the
// first place: Allure's own CLI refuses to start against a missing results
// directory but accepts an empty one, so `allure watch` already running
// against it must not be broken by a clean.

export interface RunCleanOptions {
  rootDir: string;
  /** List what would be removed without removing it. */
  dryRun: boolean;
  json: boolean;
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  notices?: readonly Finding[];
  stdout: WritableSink;
  stderr: WritableSink;
}

interface CleanPlan {
  records: string[];
  export: string[];
  legacy: string[];
}

/** Directories an earlier release wrote under the state directory and
 * nothing reads any more: `cache/` held each session's browser storage
 * state (cookies included), and `records/` held step and scenario records
 * before each run got one directory. Listed and removed by name, so a
 * project that upgraded does not keep a stale login on disk unnoticed. */
const LEGACY_DIR_NAMES = ["cache", "records"] as const;

async function buildLegacyPlan(rootDir: string, stateDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const name of LEGACY_DIR_NAMES) {
    try {
      await readdir(path.join(rootDir, stateDir, name));
      paths.push(path.join(stateDir, name));
    } catch {
      // Not there, or not a directory: nothing to remove.
    }
  }
  return paths;
}

/** Every run directory under `runs/` (run.json, summary.md, its step
 * records and scenario evidence, and its exports manifest), then every
 * `nuka do` step record under `do/`, rootDir-relative: one entry per run,
 * which is the granularity a preview of "what five `nuka run`s left
 * behind" needs, and the unit retention removes too. Missing directories (nothing ever recorded)
 * are silently zero entries, not an error: empty is a valid answer. */
async function buildRecordsPlan(rootDir: string, stateDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const relativeDir of [runsRelativeDir(stateDir), doRelativeDir(stateDir)]) {
    const dir = path.join(rootDir, relativeDir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      paths.push(path.join(relativeDir, name));
    }
  }
  return paths;
}

interface ExportPlan {
  /** Root-relative, each path under `export/` a clean removes, sorted. */
  paths: string[];
  /** `export/allure-results/` existed, so it is recreated empty. */
  resultsDirExists: boolean;
}

async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}


/** `export/allure-results/` when it holds anything, then every file a run's
 * exports manifest names that is still there, inside `export/` and outside
 * `allure-results/`. An empty `allure-results/` is what the previous clean
 * left behind, so listing it would make every second clean report a path.
 * A manifest line that leaves `export/`, through a symlink or by its
 * spelling, is not followed, and neither is the manifest of a symlinked run
 * directory (src/record/run-exports.ts's `readOwnedExports`): a clean
 * deletes only what nukadoko writes there. */
async function buildExportPlan(rootDir: string, stateDir: string): Promise<ExportPlan> {
  const resultsRelative = allureResultsRelativeDir(stateDir);
  const resultsDir = path.resolve(rootDir, resultsRelative);
  const resultsDirExists = await exists(resultsDir);
  const paths = new Set<string>();
  if (resultsDirExists && !(await isEmptyDirectory(resultsDir))) paths.add(resultsRelative);
  let runNames: string[] = [];
  try {
    runNames = await readdir(path.join(rootDir, runsRelativeDir(stateDir)));
  } catch {
    // No runs: no manifest to read.
  }
  for (const runName of runNames) {
    for (const { absolutePath } of readOwnedExports(rootDir, stateDir, runName).files) {
      if (absolutePath === resultsDir || isInsideDir(resultsDir, absolutePath)) continue;
      if (await exists(absolutePath)) paths.add(path.relative(rootDir, absolutePath));
    }
  }
  return { paths: [...paths].sort((a, b) => a.localeCompare(b)), resultsDirExists };
}

function writePlan(
  plan: CleanPlan,
  json: boolean,
  dryRun: boolean,
  stdout: WritableSink,
  notices: readonly Finding[],
): void {
  if (json) {
    stdout.write(formatEnvelope("clean", 0, notices, { ...plan, dry_run: dryRun }));
    return;
  }
  for (const relativePath of [...plan.records, ...plan.export, ...plan.legacy]) {
    stdout.write(`${relativePath}\n`);
  }
  if (plan.records.length === 0 && plan.export.length === 0 && plan.legacy.length === 0) {
    stdout.write("ok: nothing to clean\n");
  }
}

export async function runClean(options: RunCleanOptions): Promise<number> {
  const { rootDir, dryRun, json, stdout, stderr } = options;

  const sinks = { json, stdout, stderr, command: "clean" };
  const notices = options.notices ?? [];
  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }

  const exportPlan = await buildExportPlan(rootDir, config.stateDir);
  const plan: CleanPlan = {
    records: await buildRecordsPlan(rootDir, config.stateDir),
    export: exportPlan.paths,
    legacy: await buildLegacyPlan(rootDir, config.stateDir),
  };

  // The plan printed here is exactly what the execution phase below acts
  // on — one code path decides what gets deleted, this function only
  // decides whether it also deletes it.
  writePlan(plan, json, dryRun, stdout, notices);

  if (dryRun) {
    return 0;
  }

  for (const relativePath of [...plan.records, ...plan.export, ...plan.legacy]) {
    await rm(path.join(rootDir, relativePath), { recursive: true, force: true });
  }
  // A run of `nuka run --base` that was killed leaves its base tree
  // registered with git; once its run directory is gone, so is the
  // registration (src/run/git-ref.ts).
  await removeStaleTreeRegistrations(rootDir, path.join(rootDir, runsRelativeDir(config.stateDir)));
  // Recreated empty, not just removed: this file's own header explains why
  // (an `allure watch` already pointed at this directory must keep finding
  // it). A directory that was not there is not created.
  if (exportPlan.resultsDirExists) {
    await mkdir(path.join(rootDir, allureResultsRelativeDir(config.stateDir)), { recursive: true });
  }

  return 0;
}
