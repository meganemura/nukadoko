import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { DEFAULT_ENVIRONMENT_NAME } from "../environment/resolve-environment.js";
import { isMessagesRunOutputFileName } from "../report/messages/emitter.js";
import { liveLockOwner } from "../session/lock.js";
import { sessionsDir, sessionsRootDir } from "../session/paths.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

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
// only this one new caller uses is a second source of truth, not a
// reduction in duplication — it earns its existence once cli/do.ts and
// cli/run.ts actually move onto it, which this change does not do.
// `export`'s targets are resolved exactly the way cli/run.ts resolves
// them, config override included (`config.allure?.resultsDir`,
// `config.messages?.output`). `config.messages?.output` names only the
// stable, most-recently-completed-run copy the messages emitter leaves
// behind (src/report/messages/emitter.ts's own header) — every run also
// leaves its own run-id-suffixed file beside it, which a project
// accumulates one of per `nuka run` invocation, so `buildExportPlan` below
// enumerates and removes those too, not only the stable path itself.
//
// A live session is refused before anything is deleted, for every
// category, not only cache: src/live/daemon.ts is a long-running process
// that writes step records the same way `nuka do`/`nuka run` do, and a
// `nuka run --session <name>` against a live session emits Allure/messages
// output too, so `records/` and `export/` are active write targets for as
// long as that process runs, not cold storage — the same reason `nuka
// session clear` already refuses on a live lock (src/session/manage.ts),
// generalized here to every environment and every category at once rather
// than one environment's cache alone.
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

export interface RunCleanOptions {
  rootDir: string;
  /** List what would be removed without removing it. */
  dryRun: boolean;
  /** Category selection — when every one of `records`/`cache`/`export` is
   * `false` (no `--records`/`--cache`/`--export` given at all), every
   * category runs; giving any one of them narrows the clean to only the
   * ones given, the same "no filter means everything, any filter narrows
   * it" rule `nuka steps`'s own vocabulary listing never needed but a
   * destructive command does. */
  records: boolean;
  cache: boolean;
  exportArtifacts: boolean;
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

interface CleanPlan {
  records: string[];
  cache: string[];
  export: string[];
}

interface LiveSessionRef {
  environment: string;
  name: string;
  pid: number;
}

/** The first live session found, across every environment under
 * `cache/sessions/`, or `null` if none is live. Scans every environment's
 * lock files in sorted order and returns on the first live one — the same
 * "first conflict wins, no need to enumerate every one" precedent
 * `clearAllSessions` (src/session/manage.ts) already sets for one
 * environment's own lock files, widened here to every environment because
 * a clean this coarse has no single environment to scope itself to. */
async function findLiveSession(rootDir: string, stateDir: string): Promise<LiveSessionRef | null> {
  const root = sessionsRootDir(rootDir, stateDir);
  let envEntries;
  try {
    envEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const environments = envEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const environment of environments) {
    const dir = sessionsDir(rootDir, stateDir, environment);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const lockNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const lockName of lockNames) {
      const owner = await liveLockOwner(path.join(dir, lockName));
      if (owner) {
        return { environment, name: lockName.slice(0, -".lock".length), pid: owner.pid };
      }
    }
  }
  return null;
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
 * rootDir-relative. Callable only after `findLiveSession` has already
 * confirmed nothing here is live — this function does not itself check
 * liveness, so calling it first would risk deleting a live session's own
 * `.lock`/`.sock` out from under its process. */
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
  messagesOutputRelative: string;
  /** Every run-id-suffixed sibling file found beside `messagesOutputRelative`
   * (root-relative), sorted for a deterministic plan. */
  messagesRunOutputsRelative: string[];
  paths: string[];
}

/** `export/allure-results/`, `export/messages.ndjson`, and every run-id-
 * suffixed file the messages emitter left beside it, or wherever
 * `config.allure.resultsDir`/`config.messages.output` point instead —
 * resolved exactly the way cli/run.ts resolves them before handing them to
 * the two emitters, config override included, so a clean targets the same
 * place a run actually wrote to. Only a path that exists is listed: an
 * unset `resultsDir` before the first `nuka run` (past `nuka init`'s own
 * directory creation, e.g. a fresh clone) is not an error, just nothing to
 * remove there yet. */
async function buildExportPlan(
  rootDir: string,
  stateDir: string,
  allureResultsDirConfig: string | undefined,
  messagesOutputConfig: string | undefined,
): Promise<ExportPlan> {
  const resultsDirRelative = allureResultsDirConfig ?? path.join(stateDir, "export", "allure-results");
  const messagesOutputRelative = messagesOutputConfig ?? path.join(stateDir, "export", "messages.ndjson");

  const paths: string[] = [];
  if (existsSync(path.join(rootDir, resultsDirRelative))) {
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

  return { resultsDirRelative, messagesOutputRelative, messagesRunOutputsRelative, paths };
}

function writePlan(plan: CleanPlan, json: boolean, dryRun: boolean, stdout: WritableSink): void {
  if (json) {
    stdout.write(`${JSON.stringify({ ...plan, dry_run: dryRun }, null, 2)}\n`);
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
  const { rootDir, dryRun, records, cache, exportArtifacts, json, stdout, stderr } = options;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // No `--records`/`--cache`/`--export` given at all means every category
  // runs — the same "no filter, no narrowing" default `nuka check`/`nuka
  // tend` already use for their own whole-project scope.
  const anySelected = records || cache || exportArtifacts;
  const selection = anySelected
    ? { records, cache, export: exportArtifacts }
    : { records: true, cache: true, export: true };

  // Checked before anything is deleted, and before either plan is even
  // built, regardless of which categories were selected — this file's own
  // header explains why a live session gates every category, not only
  // cache.
  const live = await findLiveSession(rootDir, config.stateDir);
  if (live) {
    const envFlag = live.environment === DEFAULT_ENVIRONMENT_NAME ? "" : ` --env ${live.environment}`;
    stderr.write(
      `nuka clean: refusing, session "${live.name}" (environment "${live.environment}") is live (pid ${live.pid}); ` +
        `stop it first with \`nuka session stop ${live.name}${envFlag}\`\n`,
    );
    return 1;
  }

  const plan: CleanPlan = { records: [], cache: [], export: [] };
  let exportPlan: ExportPlan | null = null;

  if (selection.records) {
    plan.records = await buildRecordsPlan(rootDir, config.stateDir);
  }
  if (selection.cache) {
    plan.cache = await buildCachePlan(rootDir, config.stateDir);
  }
  if (selection.export) {
    exportPlan = await buildExportPlan(rootDir, config.stateDir, config.allure?.resultsDir, config.messages?.output);
    plan.export = exportPlan.paths;
  }

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
  if (exportPlan) {
    // Removed and recreated empty, not just removed, regardless of
    // whether it existed beforehand (cli/init.ts does the same
    // unconditional creation): this file's own header explains why (an
    // `allure watch` already pointed at this directory must keep finding
    // it).
    await rm(path.join(rootDir, exportPlan.resultsDirRelative), { recursive: true, force: true });
    await mkdir(path.join(rootDir, exportPlan.resultsDirRelative), { recursive: true });
    await rm(path.join(rootDir, exportPlan.messagesOutputRelative), { force: true });
    for (const relativePath of exportPlan.messagesRunOutputsRelative) {
      await rm(path.join(rootDir, relativePath), { force: true });
    }
  }

  return 0;
}
