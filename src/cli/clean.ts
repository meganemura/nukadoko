import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { doRelativeDir, exportRelativeDir, runsRelativeDir } from "../record/state-layout.js";
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
// `export/` holds what `nuka report` wrote there: every entry in it is
// removed, except `allure-history.jsonl`, Allure's own cross-run trend file
// (named via `historyPath` in the allurerc.mjs `nuka init --allure`
// writes), which clearing results between runs must never discard. A
// report written with `--out` somewhere else is the caller's file, not
// this tool's to delete.
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

/** The Allure history file `nuka init --allure` names, kept by a clean. */
const ALLURE_HISTORY_FILE_NAME = "allure-history.jsonl";
const ALLURE_RESULTS_DIR_NAME = "allure-results";

interface ExportPlan {
  /** Root-relative, each entry of `export/` a clean removes, sorted. */
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

/** Every entry of `export/` but the Allure history file. An empty
 * `allure-results/` is what the previous clean left behind, so listing it
 * would make every second clean report a path. A missing `export/` is
 * nothing to remove, not an error. */
async function buildExportPlan(rootDir: string, stateDir: string): Promise<ExportPlan> {
  const exportDir = exportRelativeDir(stateDir);
  let names: string[];
  try {
    names = (await readdir(path.join(rootDir, exportDir))).sort((a, b) => a.localeCompare(b));
  } catch {
    return { paths: [], resultsDirExists: false };
  }
  const resultsDirExists = names.includes(ALLURE_RESULTS_DIR_NAME);
  const paths: string[] = [];
  for (const name of names) {
    if (name === ALLURE_HISTORY_FILE_NAME) continue;
    if (name === ALLURE_RESULTS_DIR_NAME && (await isEmptyDirectory(path.join(rootDir, exportDir, name)))) continue;
    paths.push(path.join(exportDir, name));
  }
  return { paths, resultsDirExists };
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
  for (const relativePath of [...plan.records, ...plan.export]) {
    stdout.write(`${relativePath}\n`);
  }
  if (plan.records.length === 0 && plan.export.length === 0) {
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
  };

  // The plan printed here is exactly what the execution phase below acts
  // on — one code path decides what gets deleted, this function only
  // decides whether it also deletes it.
  writePlan(plan, json, dryRun, stdout, notices);

  if (dryRun) {
    return 0;
  }

  for (const relativePath of [...plan.records, ...plan.export]) {
    await rm(path.join(rootDir, relativePath), { recursive: true, force: true });
  }
  // Recreated empty, not just removed: this file's own header explains why
  // (an `allure watch` already pointed at this directory must keep finding
  // it). A directory that was not there is not created.
  if (exportPlan.resultsDirExists) {
    await mkdir(path.join(rootDir, exportRelativeDir(config.stateDir), ALLURE_RESULTS_DIR_NAME), { recursive: true });
  }

  return 0;
}
