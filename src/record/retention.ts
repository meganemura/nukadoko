import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { findLiveSessions, type LiveSessionRef } from "../live/live-session-notice.js";
import { messagesRunOutputPath } from "../report/messages/emitter.js";
import type { ScenarioRecord } from "../run/record-types.js";
import { readExportsManifest, RUN_EXPORTS_FILE_NAME, runDir } from "./run-exports.js";

// Responsibility: what leaves the state directory on its own, and when.
// Two rules, applied at the end of every `nuka run` (src/cli/run.ts):
//
// 1. The run rule. A run is every scenario record sharing one `run_id`,
//    dated by the earliest `started_at` among them (the same rule `nuka
//    accept` and `nuka tend` use to name the newest run, so the three
//    commands never disagree about which run that is). The newest
//    `retention.runs` runs keep everything: scenario records, the step
//    records their `steps[]` cite, the export files their manifest lists
//    (src/record/run-exports.ts), and their messages stream. Every older
//    run loses all of it. Runs are derived from the records themselves,
//    not from a list the tool keeps, so a run that stopped after writing
//    some scenario records, and every run written before this rule
//    existed, still falls under it.
//
// 2. The age rule, for what no retained run owns: a `nuka do` or
//    `recordStep` step record (`run_id: null`), a step record whose run has
//    since been removed, a scenario directory whose record.json cannot be
//    read, and a run directory with a manifest but no scenario records (a
//    run that stopped before its first scenario finished). Each is dated by
//    its own record's `finished_at` (`started_at` failing that) and, when
//    the record cannot be read at all, by the directory's mtime, and is
//    removed once older than `retention.adHocDays`. `nuka do --use` and
//    `nuka harvest` read these across days by design, which is why they
//    get days rather than a run count.
//
// Export files are removed only through a manifest. A results directory
// can be shared with another tool's Allure output, so a file nothing here
// wrote is never touched, however old; `nuka clean --export` is the
// operation for a directory that predates manifests.
//
// Skipped entirely, and said so, while a live session (`nuka session
// start`'s daemon) is up anywhere: that process writes records for as long
// as it runs, and a rule that removes records has no business under it,
// the same reason `nuka clean` refuses. A lock with no socket is not a
// live session in this sense: it is a `nuka run --session`/`nuka do
// --session` holding the name for the length of one command, and at the
// end of `nuka run` that command is the one running retention.
//
// A second `nuka run` in flight at the same time is safe by construction:
// its scenario records carry its own `run_id` with a `started_at` newer
// than anything this invocation could rank it below, its manifest is
// listed under a run this invocation keeps, and the age rule needs days.

export interface RetentionPolicy {
  readonly runs: number;
  readonly adHocDays: number;
}

export interface RunSummary {
  readonly runId: string;
  /** Epoch milliseconds of the earliest `started_at` in the run. */
  readonly startedAt: number;
}

export interface RunRetentionPlan {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

/** The newest `keep` runs by `startedAt`, ties broken by `runId` (a run
 * id carries its own wall-clock digits, so a later id ranks newer). Pure,
 * and independent of the order `runs` arrive in: the caller reads them
 * from a directory listing whose order the filesystem decides. */
export function planRunRetention(runs: readonly RunSummary[], keep: number): RunRetentionPlan {
  const ordered = [...runs].sort((a, b) => b.startedAt - a.startedAt || (b.runId < a.runId ? -1 : b.runId > a.runId ? 1 : 0));
  const kept = ordered.slice(0, Math.max(0, keep)).map((run) => run.runId);
  const dropped = ordered.slice(Math.max(0, keep)).map((run) => run.runId);
  return { kept, dropped };
}

export interface DatedEntry {
  readonly id: string;
  /** Epoch milliseconds, or `null` when nothing could date the entry — an
   * undatable entry is never removed. */
  readonly at: number | null;
}

/** The ids whose date is before `cutoff`, in the order given. */
export function planAgeRetention(entries: readonly DatedEntry[], cutoff: number): string[] {
  return entries.filter((entry) => entry.at !== null && entry.at < cutoff).map((entry) => entry.id);
}

interface ScenarioDirEntry {
  readonly id: string;
  readonly record: ScenarioRecord | null;
  readonly mtimeMs: number | null;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function readRecordJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, "record.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isScenarioRecord(value: Record<string, unknown>): value is Record<string, unknown> & ScenarioRecord {
  return (
    typeof value.run_id === "string" &&
    typeof value.scenario_record_id === "string" &&
    typeof value.started_at === "string" &&
    Array.isArray(value.steps)
  );
}

async function readScenarioDirs(scenariosDir: string): Promise<ScenarioDirEntry[]> {
  const entries: ScenarioDirEntry[] = [];
  for (const id of await listDirectories(scenariosDir)) {
    const dir = path.join(scenariosDir, id);
    const raw = await readRecordJson(dir);
    entries.push({
      id,
      record: raw !== null && isScenarioRecord(raw) ? raw : null,
      mtimeMs: await mtimeOf(dir),
    });
  }
  return entries;
}

/** Groups scenario records into runs by `run_id`, each dated by its
 * earliest parseable `started_at`. A record whose `started_at` does not
 * parse still belongs to its run; a run with no parseable date at all is
 * dated as newest (never removed by the run rule), since removing what
 * cannot be dated is the one thing neither rule does. */
export function groupRuns(records: readonly ScenarioRecord[]): Map<string, { summary: RunSummary; records: ScenarioRecord[] }> {
  const byRun = new Map<string, { startedAt: number | null; records: ScenarioRecord[] }>();
  for (const record of records) {
    const startedAt = Date.parse(record.started_at);
    const at = Number.isNaN(startedAt) ? null : startedAt;
    const group = byRun.get(record.run_id);
    if (group === undefined) {
      byRun.set(record.run_id, { startedAt: at, records: [record] });
    } else {
      group.records.push(record);
      if (at !== null) {
        group.startedAt = group.startedAt === null ? at : Math.min(group.startedAt, at);
      }
    }
  }
  const runs = new Map<string, { summary: RunSummary; records: ScenarioRecord[] }>();
  for (const [runId, group] of byRun) {
    runs.set(runId, {
      summary: { runId, startedAt: group.startedAt ?? Number.POSITIVE_INFINITY },
      records: group.records,
    });
  }
  return runs;
}

/** The record's own `finished_at`, else `started_at`, as epoch
 * milliseconds; `null` when neither parses. */
function recordDate(record: Record<string, unknown> | null): number | null {
  if (record === null) return null;
  for (const key of ["finished_at", "started_at"]) {
    const value = record[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function isInside(rootDir: string, absolutePath: string): boolean {
  const relative = path.relative(rootDir, absolutePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface ApplyRetentionOptions {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly policy: RetentionPolicy;
  readonly now: Date;
  /** Root-relative `messages.ndjson` path, as `nuka run` resolves it,
   * so a run's own run-id-suffixed stream can be named beside it. */
  readonly messagesOutputRel: string;
}

export interface RetentionOutcome {
  /** Non-null when nothing was examined at all. */
  readonly skipped: { readonly liveSessions: readonly LiveSessionRef[] } | null;
  readonly runsKept: number;
  readonly runsRemoved: number;
  /** Step records, scenario directories, and run directories the age rule
   * removed, counted together: none of them belonged to a retained run. */
  readonly unownedRemoved: number;
}

async function removeRunExports(
  rootDir: string,
  stateDir: string,
  runId: string,
  messagesOutputRel: string,
): Promise<void> {
  const dir = runDir(rootDir, stateDir, runId);
  for (const relativePath of readExportsManifest(path.join(dir, RUN_EXPORTS_FILE_NAME))) {
    const absolutePath = path.resolve(rootDir, relativePath);
    // A manifest is this tool's own file, but a removal that could reach
    // outside the project is still refused rather than trusted.
    if (!isInside(rootDir, absolutePath)) continue;
    await rm(absolutePath, { force: true });
  }
  await rm(messagesRunOutputPath(path.join(rootDir, messagesOutputRel), runId), { force: true });
  await rm(dir, { recursive: true, force: true });
}

export async function applyRetention(options: ApplyRetentionOptions): Promise<RetentionOutcome> {
  const { rootDir, stateDir, policy, now, messagesOutputRel } = options;

  const liveSessions = await findLiveSessions(rootDir, stateDir);
  if (liveSessions.length > 0) {
    return { skipped: { liveSessions }, runsKept: 0, runsRemoved: 0, unownedRemoved: 0 };
  }

  const recordsDir = path.join(rootDir, stateDir, "records");
  const stepsDir = path.join(recordsDir, "steps");
  const scenariosDir = path.join(recordsDir, "scenarios");
  const runsDir = path.join(recordsDir, "runs");

  // --- The run rule ---
  const scenarioDirs = await readScenarioDirs(scenariosDir);
  const runs = groupRuns(scenarioDirs.flatMap((entry) => (entry.record !== null ? [entry.record] : [])));
  const plan = planRunRetention([...runs.values()].map((run) => run.summary), policy.runs);

  const ownedSteps = new Set<string>();
  const ownedScenarios = new Set<string>();
  for (const runId of plan.kept) {
    for (const record of runs.get(runId)?.records ?? []) {
      ownedScenarios.add(record.scenario_record_id);
      for (const step of record.steps) {
        if (step.step_record_id !== null) ownedSteps.add(step.step_record_id);
      }
    }
  }

  for (const runId of plan.dropped) {
    for (const record of runs.get(runId)?.records ?? []) {
      for (const step of record.steps) {
        if (step.step_record_id !== null && !ownedSteps.has(step.step_record_id)) {
          await rm(path.join(stepsDir, step.step_record_id), { recursive: true, force: true });
        }
      }
      await rm(path.join(scenariosDir, record.scenario_record_id), { recursive: true, force: true });
    }
    await removeRunExports(rootDir, stateDir, runId, messagesOutputRel);
  }

  // --- The age rule ---
  const cutoff = now.getTime() - policy.adHocDays * 24 * 60 * 60 * 1000;
  let unownedRemoved = 0;

  const stepEntries: DatedEntry[] = [];
  for (const id of await listDirectories(stepsDir)) {
    if (ownedSteps.has(id)) continue;
    const dir = path.join(stepsDir, id);
    stepEntries.push({ id, at: recordDate(await readRecordJson(dir)) ?? (await mtimeOf(dir)) });
  }
  for (const id of planAgeRetention(stepEntries, cutoff)) {
    await rm(path.join(stepsDir, id), { recursive: true, force: true });
    unownedRemoved += 1;
  }

  const scenarioEntries: DatedEntry[] = scenarioDirs
    .filter((entry) => entry.record === null && !ownedScenarios.has(entry.id))
    .map((entry) => ({ id: entry.id, at: entry.mtimeMs }));
  for (const id of planAgeRetention(scenarioEntries, cutoff)) {
    await rm(path.join(scenariosDir, id), { recursive: true, force: true });
    unownedRemoved += 1;
  }

  const runEntries: DatedEntry[] = [];
  for (const runId of await listDirectories(runsDir)) {
    if (runs.has(runId)) continue;
    runEntries.push({ id: runId, at: await mtimeOf(path.join(runsDir, runId)) });
  }
  for (const runId of planAgeRetention(runEntries, cutoff)) {
    await removeRunExports(rootDir, stateDir, runId, messagesOutputRel);
    unownedRemoved += 1;
  }

  return {
    skipped: null,
    runsKept: plan.kept.length,
    runsRemoved: plan.dropped.length,
    unownedRemoved,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** One stderr line, or none when nothing happened: a run that removed
 * nothing keeps its output identical to before this rule existed. A skip
 * is always a line, since a person reading a growing state directory has
 * to be able to find out why. */
export function formatRetention(outcome: RetentionOutcome, policy: RetentionPolicy): string | null {
  if (outcome.skipped !== null) {
    const first = outcome.skipped.liveSessions[0]!;
    return `retention: skipped, session "${first.name}" (environment "${first.environment}") is live; nothing is removed while a session can still write records`;
  }
  const parts: string[] = [];
  if (outcome.runsRemoved > 0) {
    parts.push(`${plural(outcome.runsRemoved, "run", "runs")} older than the newest ${policy.runs} (retention.runs)`);
  }
  if (outcome.unownedRemoved > 0) {
    parts.push(
      `${plural(outcome.unownedRemoved, "record", "records")} no retained run owns, older than ${plural(policy.adHocDays, "day", "days")} (retention.adHocDays)`,
    );
  }
  if (parts.length === 0) return null;
  return `retention: removed ${parts.join(", and ")}`;
}
