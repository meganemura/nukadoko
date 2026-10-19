import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { compareNewestFirst, rankRunsNewestFirst, type RunStart } from "./newest-run.js";
import { readOwnedExports, runDir } from "./run-exports.js";
import { readEndedRuns } from "./run-result.js";
import { doRelativeDir, runsRelativeDir } from "./state-layout.js";

// Responsibility: what leaves the state directory on its own, and when.
// Applied at the end of every `nuka run` (src/cli/run.ts). The unit is a
// whole run directory, `<stateDir>/runs/<run_id>/` (src/record/
// state-layout.ts): a run is removed with everything it measured, its
// run.json, summary, step records, and scenario evidence, and nothing
// inside a kept run is ever removed on its own. The alternative refused
// was removing files by the ids a run.json cites, which is what kept
// retention reading every record before it could remove one.
//
// 1. The run rule. A run that ended is a run directory with a run.json
//    (src/record/run-result.ts), dated by its `started_at`
//    (src/record/newest-run.ts, the rule `nuka tend` uses too). The newest
//    `retention.runs` runs are kept; every older run directory is removed,
//    with the export files its manifest lists (src/record/run-exports.ts):
//    what `nuka report` wrote under the state directory for it. The run that is applying retention counts as
//    one of the runs, though its run.json is written after this, and it is
//    never removed.
//
// 2. The age rule, for what no run rule can date: a run directory with no
//    run.json (a run still in flight in another process, or one that was
//    killed), dated by its mtime, and a `nuka do` step record under
//    `<stateDir>/do/`, dated by its own `finished_at` (`started_at`
//    failing that, the directory's mtime failing both). Each is removed
//    once older than `retention.adHocDays`. A run still writing has no
//    run.json yet, so it is never ranked against the runs that ended
//    first, and `nuka do --use` reads `do/` records across days by design,
//    which is why they get days rather than a run count.
//
// Export files are removed only through a manifest. A results directory
// can be shared with another tool's Allure output, so a file nothing here
// wrote is never touched, however old; `nuka clean` is the operation for a
// directory that predates manifests. A manifest line is followed only when
// it resolves, through every symlink, inside `<stateDir>/export/`
// (src/record/run-exports.ts's `readOwnedExports`): a run directory can be
// copied in from elsewhere, and its manifest is not trusted to name only
// what `nuka report` wrote.

export interface RetentionPolicy {
  readonly runs: number;
  readonly adHocDays: number;
}

export type RunSummary = RunStart;

export interface RunRetentionPlan {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

/** The newest `keep` runs. Pure, and independent of the order `runs`
 * arrive in: the caller reads them from a directory listing whose order the
 * filesystem decides. */
export function planRunRetention(runs: readonly RunSummary[], keep: number): RunRetentionPlan {
  const ordered = [...runs].sort(compareNewestFirst);
  const kept = ordered.slice(0, Math.max(0, keep)).map((run) => run.runId);
  const dropped = ordered.slice(Math.max(0, keep)).map((run) => run.runId);
  return { kept, dropped };
}

export interface DatedEntry {
  readonly id: string;
  /** Epoch milliseconds, or `null` when nothing could date the entry. An
   * undatable entry is never removed. */
  readonly at: number | null;
}

/** The ids whose date is before `cutoff`, in the order given. */
export function planAgeRetention(entries: readonly DatedEntry[], cutoff: number): string[] {
  return entries.filter((entry) => entry.at !== null && entry.at < cutoff).map((entry) => entry.id);
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


export interface ApplyRetentionOptions {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly policy: RetentionPolicy;
  readonly now: Date;
  /** The run that is applying retention, before its run.json exists. It
   * counts as a run and is never removed. */
  readonly currentRun: RunStart;
}

export interface RetentionOutcome {
  readonly runsKept: number;
  readonly runsRemoved: number;
  /** Run directories with no run.json and `nuka do` step records the age
   * rule removed, counted together: no run rule dated any of them. */
  readonly unownedRemoved: number;
}

/** Removes one run directory whole, after the export files its manifest
 * lists. */
async function removeRunDir(rootDir: string, stateDir: string, runId: string): Promise<void> {
  for (const { absolutePath } of readOwnedExports(rootDir, stateDir, runId).files) await rm(absolutePath, { force: true });
  // A symlinked run directory is removed as the link: `rm` does not follow
  // it into where it points.
  await rm(runDir(rootDir, stateDir, runId), { recursive: true, force: true });
}

export async function applyRetention(options: ApplyRetentionOptions): Promise<RetentionOutcome> {
  const { rootDir, stateDir, policy, now, currentRun } = options;
  const runsDir = path.join(rootDir, runsRelativeDir(stateDir));
  const doDir = path.join(rootDir, doRelativeDir(stateDir));

  // --- The run rule ---
  const ended: RunStart[] = rankRunsNewestFirst(readEndedRuns(rootDir, stateDir)).map(({ runId, startedAt }) => ({
    runId,
    startedAt,
  }));
  const ranked: RunStart[] = ended.some((run) => run.runId === currentRun.runId) ? ended : [currentRun, ...ended];
  const plan = planRunRetention(ranked, policy.runs);
  const dropped = plan.dropped.filter((runId) => runId !== currentRun.runId);
  for (const runId of dropped) await removeRunDir(rootDir, stateDir, runId);

  // --- The age rule ---
  let unownedRemoved = 0;
  const cutoff = now.getTime() - policy.adHocDays * 24 * 60 * 60 * 1000;

  const rankedIds = new Set(ranked.map((run) => run.runId));
  const runEntries: DatedEntry[] = [];
  for (const runId of await listDirectories(runsDir)) {
    if (rankedIds.has(runId)) continue;
    runEntries.push({ id: runId, at: await mtimeOf(path.join(runsDir, runId)) });
  }
  for (const runId of planAgeRetention(runEntries, cutoff)) {
    await removeRunDir(rootDir, stateDir, runId);
    unownedRemoved += 1;
  }

  const doEntries: DatedEntry[] = [];
  for (const id of await listDirectories(doDir)) {
    const dir = path.join(doDir, id);
    doEntries.push({ id, at: recordDate(await readRecordJson(dir)) ?? (await mtimeOf(dir)) });
  }
  for (const id of planAgeRetention(doEntries, cutoff)) {
    await rm(path.join(doDir, id), { recursive: true, force: true });
    unownedRemoved += 1;
  }

  return {
    runsKept: ranked.length - dropped.length,
    runsRemoved: dropped.length,
    unownedRemoved,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** One stderr line, or none when nothing happened: a run that removed
 * nothing keeps its output identical to before this rule existed. */
export function formatRetention(outcome: RetentionOutcome, policy: RetentionPolicy): string | null {
  const parts: string[] = [];
  if (outcome.runsRemoved > 0) {
    parts.push(`${plural(outcome.runsRemoved, "run", "runs")} older than the newest ${policy.runs} (retention.runs)`);
  }
  if (outcome.unownedRemoved > 0) {
    parts.push(
      `${plural(outcome.unownedRemoved, "unfinished run or nuka do record", "unfinished runs and nuka do records")} older than ${plural(policy.adHocDays, "day", "days")} (retention.adHocDays)`,
    );
  }
  if (parts.length === 0) return null;
  return `retention: removed ${parts.join(", and ")}`;
}

/** The sentence a "no such step record" refusal carries, so a person
 * whose `--use` id stopped resolving learns that records have a
 * lifetime before they go looking for a typo. Built from the policy in
 * force, since the numbers are the whole answer. */
export function retentionNote(policy: RetentionPolicy): string {
  return (
    `A step record is removed with its run once the run is older than the newest ${plural(policy.runs, "run", "runs")}, ` +
    `and a nuka do record once it is older than ${plural(policy.adHocDays, "day", "days")} ` +
    "(retention in nukadoko.config.ts)"
  );
}
