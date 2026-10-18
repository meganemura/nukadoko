import { versioned } from "../record/schema-version.js";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { isMessagesRunOutputFileName } from "../record/messages-output.js";
import { sessionsDir, sessionsRootDir } from "../session/paths.js";
import { helpFor, refuse } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka clean`'s actual work — delete the disposable half
// of the state directory (docs/spec.md "Artifacts": Measurement and Cache
// and Export), kept out of run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts, cli/check.ts). This is the
// whole-category operation; the routine, bounded removal is retention
// (src/record/retention.ts), which `nuka run` applies on its own at the
// end of every run. `clean` stays for what retention deliberately never
// touches: everything at once, a results directory that predates the
// per-run manifests retention needs, and the cache.
//
// Path resolution is inlined here rather than shared with cli/do.ts,
// cli/run.ts, or src/session/manage.ts's own `clearAllSessions`: those are
// the state directory's own fixed segments (docs/spec.md "The state
// directory" names all of them: `records/steps`, `records/scenarios`,
// `records/runs`, `cache/sessions/<env>/`), not this module's own invention, but a helper
// only this one caller uses is a second source of truth, not a
// reduction in duplication. It earns its existence once cli/do.ts and
// cli/run.ts resolve those segments through it too. Until then the paths
// stay inlined here.
// `export`'s targets are resolved exactly the way cli/run.ts resolves
// them, config override included (`config.allure?.resultsDir`,
// `config.messages?.output`). `config.messages?.output` names only the
// stable, most-recently-completed-run copy the messages emitter leaves
// behind (src/report/messages/emitter.ts's own header) — every run also
// leaves its own run-id-suffixed file beside it, which a project
// accumulates one of per `nuka run` invocation, so `buildExportPlan` below
// enumerates and removes those too, not only the stable path itself.
//
// `export/allure-results/` is removed and immediately recreated empty,
// mirroring cli/init.ts's own reasoning for creating it that way in the
// first place: Allure's own CLI refuses to start against a missing results
// directory but accepts an empty one, so `allure watch` already running
// against it must not be broken by a clean. `export/allure-history.jsonl`
// (Allure's own cross-run trend file, named via `historyPath` in
// allurerc.mjs) is a deliberate non-target: it is never named by
// `config.allure?.resultsDir`/`config.messages?.output`, so it is never
// enumerated or deleted here, the same guarantee cli/init.ts's own comment
// describes ("kept beside the disposable allure-results/ directory ...
// clearing results between runs never discards it").
//
// `allure.resultsDir` and `messages.output` are refused, before the plan is
// built and before anything is removed, when the path resolves to the
// project root, to somewhere outside the project, or to a parent of the
// state directory. Removing the project root removes the project. Removing
// a parent of the state directory removes that directory as a side effect
// of cleaning export. A path outside the project is not this tool's to
// delete: retention already skips a manifest line that leaves the project,
// and clean follows that boundary instead of treating the two config keys
// as permission to delete wherever they point. `--dry-run` refuses too. A
// dry-run that printed `.` and exited 0 would be the command agreeing to
// delete the project. The check uses `path.resolve`, so `..` and an
// absolute path are judged by where they land.

export interface RunCleanOptions {
  rootDir: string;
  /** List what would be removed without removing it. */
  dryRun: boolean;
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

interface CleanPlan {
  records: string[];
  cache: string[];
  export: string[];
}

/** Every step/scenario record id directory under `records/steps/` and
 * `records/scenarios/`, and every run's own directory under
 * `records/runs/` (its exports manifest, src/record/run-exports.ts),
 * rootDir-relative — one entry per accumulated run's
 * own leftovers, which is the granularity a preview of "what five `nuka
 * run`s left behind" needs (a single "records/" line would say nothing
 * about how much piled up). Missing directories (nothing ever recorded)
 * are silently zero entries, not an error: the same "empty is a valid
 * answer" rule `session list` already follows. */
async function buildRecordsPlan(rootDir: string, stateDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const kind of ["steps", "scenarios", "runs"] as const) {
    const dir = path.join(rootDir, stateDir, "records", kind);
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
      paths.push(path.join(stateDir, "records", kind, name));
    }
  }
  return paths;
}

/** Every file under every environment's `cache/sessions/<env>/` directory,
 * rootDir-relative. */
async function buildCachePlan(rootDir: string, stateDir: string): Promise<string[]> {
  const root = sessionsRootDir(rootDir, stateDir);
  let envEntries;
  try {
    envEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const environments = envEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const paths: string[] = [];
  for (const environment of environments) {
    const dir = sessionsDir(rootDir, stateDir, environment);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      paths.push(path.join(stateDir, "cache", "sessions", environment, name));
    }
  }
  return paths;
}

interface ExportPlan {
  resultsDirRelative: string;
  resultsDirExists: boolean;
  messagesOutputRelative: string;
  /** Every run-id-suffixed sibling file found beside `messagesOutputRelative`
   * (root-relative), sorted for a deterministic plan. */
  messagesRunOutputsRelative: string[];
  paths: string[];
}

/** `null` when `configuredPath` may be removed: the resolved path is strictly
 * inside the project and is not a parent of the state directory. The project
 * root is refused because it is not inside itself, and removing it removes
 * the project. A path outside the project is refused because this tool does
 * not delete what it does not own. A parent of the state directory is refused
 * because removing it removes the state directory with it.
 *
 * `path.resolve` decides, so `..` and an absolute path are judged by where
 * they land. */
export function refuseExportTarget(
  rootDir: string,
  stateDir: string,
  configuredPath: string,
  label: string,
): string | null {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, configuredPath);
  const state = path.resolve(root, stateDir);
  if (target === root) {
    return `nuka clean: refusing, ${label} "${configuredPath}" resolves to the project root`;
  }
  if (!isStrictlyInside(root, target)) {
    return `nuka clean: refusing, ${label} "${configuredPath}" resolves outside the project`;
  }
  if (isStrictlyInside(target, state)) {
    return `nuka clean: refusing, ${label} "${configuredPath}" is a parent of the state directory`;
  }
  return null;
}

/** `child` sits strictly inside `parent`. The parent itself does not: a
 * removal of the parent would remove the parent. A climb (`..`) or a path
 * that is absolute against another root is not inside. */
function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

type BuiltExportPlan = { refusal: string; plan: null } | { refusal: null; plan: ExportPlan };

/** `export/allure-results/`, `export/messages.ndjson`, and every run-id-
 * suffixed file the messages emitter left beside it, or wherever
 * `config.allure.resultsDir`/`config.messages.output` point instead.
 * Resolved exactly the way cli/run.ts resolves them before handing them to
 * the two emitters, config override included, so a clean targets the same
 * place a run actually wrote to. Only a path that exists is listed: an
 * unset `resultsDir` before the first `nuka run` (past `nuka init`'s own
 * directory creation, e.g. a fresh clone) is not an error, just nothing to
 * remove there yet. A path `refuseExportTarget` rejects is returned as a
 * refusal and is not listed or read: the messages sibling scan would
 * otherwise readdir a directory outside the project. */
async function buildExportPlan(
  rootDir: string,
  stateDir: string,
  allureResultsDirConfig: string | undefined,
  messagesOutputConfig: string | undefined,
): Promise<BuiltExportPlan> {
  const resultsConfigured = allureResultsDirConfig ?? path.join(stateDir, "export", "allure-results");
  const messagesConfigured = messagesOutputConfig ?? path.join(stateDir, "export", "messages.ndjson");
  const refusal =
    refuseExportTarget(rootDir, stateDir, resultsConfigured, "allure.resultsDir") ??
    refuseExportTarget(rootDir, stateDir, messagesConfigured, "messages.output");
  if (refusal !== null) {
    return { refusal, plan: null };
  }
  // Root-relative from here on. An absolute path that landed inside the
  // project, and a `..` that stayed inside it, both join back onto rootDir
  // at the place `path.resolve` already accepted.
  const root = path.resolve(rootDir);
  const resultsDirRelative = path.relative(root, path.resolve(root, resultsConfigured));
  const messagesOutputRelative = path.relative(root, path.resolve(root, messagesConfigured));

  const paths: string[] = [];
  // An empty results directory is what the previous clean left behind, so
  // listing it would make every second clean report a path.
  const resultsDirExists = existsSync(path.join(rootDir, resultsDirRelative));
  if (resultsDirExists && !(await isEmptyDirectory(path.join(rootDir, resultsDirRelative)))) {
    paths.push(resultsDirRelative);
  }
  if (existsSync(path.join(rootDir, messagesOutputRelative))) {
    paths.push(messagesOutputRelative);
  }

  // Every run-id-suffixed file beside `messagesOutputRelative`
  // (src/report/messages/emitter.ts's own header: the configured path is
  // only ever a post-hoc copy of the most recently *completed* run, and
  // each run's own real stream lives in one of these instead). A missing
  // directory (no `nuka run` has written there yet) is zero entries, not
  // an error, same convention as buildRecordsPlan/buildCachePlan above.
  const messagesDirRelative = path.dirname(messagesOutputRelative);
  const messagesRunOutputsRelative: string[] = [];
  try {
    const entries = await readdir(path.join(rootDir, messagesDirRelative), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && isMessagesRunOutputFileName(messagesOutputRelative, entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      messagesRunOutputsRelative.push(path.join(messagesDirRelative, name));
    }
  } catch {
    // Directory doesn't exist yet: nothing to enumerate.
  }
  paths.push(...messagesRunOutputsRelative);

  return {
    refusal: null,
    plan: { resultsDirRelative, resultsDirExists, messagesOutputRelative, messagesRunOutputsRelative, paths },
  };
}

function writePlan(plan: CleanPlan, json: boolean, dryRun: boolean, stdout: WritableSink): void {
  if (json) {
    stdout.write(`${JSON.stringify(versioned("clean_plan", { ...plan, dry_run: dryRun }), null, 2)}\n`);
    return;
  }
  for (const relativePath of [...plan.records, ...plan.cache, ...plan.export]) {
    stdout.write(`${relativePath}\n`);
  }
  if (plan.records.length === 0 && plan.cache.length === 0 && plan.export.length === 0) {
    stdout.write("ok: nothing to clean\n");
  }
}

export async function runClean(options: RunCleanOptions): Promise<number> {
  const { rootDir, dryRun, json, stdout, stderr } = options;

  const sinks = { json, stdout, stderr };
  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    return refuse(sinks, error, helpFor("clean"));
  }

  const built = await buildExportPlan(rootDir, config.stateDir, config.allure?.resultsDir, config.messages?.output);
  // Before writePlan and before any rm.
  if (built.refusal !== null) {
    return refuse(sinks, built.refusal, helpFor("clean"));
  }
  const exportPlan = built.plan;
  const plan: CleanPlan = {
    records: await buildRecordsPlan(rootDir, config.stateDir),
    cache: await buildCachePlan(rootDir, config.stateDir),
    export: exportPlan.paths,
  };

  // The plan printed here is exactly what the execution phase below acts
  // on — one code path decides what gets deleted, this function only
  // decides whether it also deletes it.
  writePlan(plan, json, dryRun, stdout);

  if (dryRun) {
    return 0;
  }

  for (const relativePath of plan.records) {
    await rm(path.join(rootDir, relativePath), { recursive: true, force: true });
  }
  for (const relativePath of plan.cache) {
    await rm(path.join(rootDir, relativePath), { force: true });
  }
  // Removed and recreated empty, not just removed: this file's own header
  // explains why (an `allure watch` already pointed at this directory must
  // keep finding it). A directory that was not there is not created, since
  // the Allure emitter is off unless the config turns it on.
  if (exportPlan.resultsDirExists) {
    await rm(path.join(rootDir, exportPlan.resultsDirRelative), { recursive: true, force: true });
    await mkdir(path.join(rootDir, exportPlan.resultsDirRelative), { recursive: true });
  }
  await rm(path.join(rootDir, exportPlan.messagesOutputRelative), { force: true });
  for (const relativePath of exportPlan.messagesRunOutputsRelative) {
    await rm(path.join(rootDir, relativePath), { force: true });
  }

  return 0;
}
