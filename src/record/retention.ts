import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { messagesRunOutputPath } from "./messages-output.js";
import { compareNewestFirst, rankRunsNewestFirst, type RunStart } from "./newest-run.js";
import { readExportsManifest, RUN_EXPORTS_FILE_NAME, runDir } from "./run-exports.js";
import { readEndedRuns } from "./run-result.js";

// Responsibility: what leaves the state directory on its own, and when.
// Two rules, applied at the end of every `nuka run` (src/cli/run.ts):
//
// 1. The run rule. A run is a run.json (src/record/run-result.ts), dated by
//    its `started_at` (src/record/newest-run.ts, the rule `nuka tend` uses
//    too). The newest `retention.runs` runs keep everything: the step
//    records and scenario evidence directories their run.json names, the
//    export files their manifest lists (src/record/run-exports.ts), and
//    their messages stream. Every older run loses all of it. The run that
//    is applying retention counts as one of the runs, though its run.json
//    is written after this, and it is never removed.
//
// 2. The age rule, for what no retained run owns: a `nuka do` step record
//    (`run_id: null`), a step record or scenario directory whose run has
//    since been removed or never wrote its run.json, and a run directory
//    with no run.json. Each is dated by its own record's `finished_at`
//    (`started_at` failing that) and, when there is no record to read, by
//    the directory's mtime, and is removed once older than
//    `retention.adHocDays`. `nuka do --use` reads these across days by
//    design, which is why they get days rather than a run count.
//
// A run owns exactly the step records its run.json names. That set is
// complete: a part invoked through the `call` fixture runs inside its
// caller and lands as a `calls[]` entry on the caller's own record, never as
// a `records/steps/<id>/` of its own, and a hook's evidence lives inside the
// scenario's own directory.
//
// Export files are removed only through a manifest. A results directory
// can be shared with another tool's Allure output, so a file nothing here
// wrote is never touched, however old; `nuka clean` is the operation for a
// directory that predates manifests. A manifest line that resolves outside
// the project root is skipped as well: `allure.resultsDir` can point above
// the project, and a removal that leaves the project is not one this tool
// makes on its own.
//
// A second `nuka run` in flight at the same time is safe because the run
// rule only ranks a run that wrote its run.json, the run's last act. A run
// still writing, a run killed mid-way, and a run from before run.json held
// its scenarios all have none, and what they wrote falls to the age rule.

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
  /** The run that is applying retention, before its run.json exists. It
   * counts as a run and is never removed. */
  readonly currentRun: RunStart;
}

export interface RetentionOutcome {
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
  // The manifest names the stream of every run that noted it. A run written
  // before the stream was noted is found by the name the current
  // `messages.output` gives it.
  await rm(messagesRunOutputPath(path.resolve(rootDir, messagesOutputRel), runId), { force: true });
  await rm(dir, { recursive: true, force: true });
}

interface EndedRun extends RunStart {
  readonly steps: readonly string[];
  readonly scenarios: readonly string[];
}

export async function applyRetention(options: ApplyRetentionOptions): Promise<RetentionOutcome> {
  const { rootDir, stateDir, policy, now, messagesOutputRel, currentRun } = options;

  const recordsDir = path.join(rootDir, stateDir, "records");
  const stepsDir = path.join(recordsDir, "steps");
  const scenariosDir = path.join(recordsDir, "scenarios");
  const runsDir = path.join(recordsDir, "runs");

  // --- The run rule ---
  const ended: EndedRun[] = rankRunsNewestFirst(readEndedRuns(rootDir, stateDir)).map(({ runId, startedAt, run }) => ({
    runId,
    startedAt,
    steps: run.scenarios.flatMap((scenario) =>
      (scenario.steps ?? []).flatMap((step) => (typeof step.step_record_id === "string" ? [step.step_record_id] : [])),
    ),
    scenarios: run.scenarios.flatMap((scenario) =>
      typeof scenario.evidence?.dir === "string" ? [path.basename(scenario.evidence.dir)] : [],
    ),
  }));
  const ranked: RunStart[] = ended.some((run) => run.runId === currentRun.runId) ? ended : [currentRun, ...ended];
  const plan = planRunRetention(ranked, policy.runs);
  const dropped = new Set(plan.dropped.filter((runId) => runId !== currentRun.runId));
  const retained = ended.filter((run) => !dropped.has(run.runId));

  const ownedSteps = new Set(retained.flatMap((run) => run.steps));
  const ownedScenarios = new Set(retained.flatMap((run) => run.scenarios));

  for (const run of ended.filter((entry) => dropped.has(entry.runId))) {
    for (const id of run.steps) {
      if (!ownedSteps.has(id)) await rm(path.join(stepsDir, id), { recursive: true, force: true });
    }
    for (const id of run.scenarios) {
      if (!ownedScenarios.has(id)) await rm(path.join(scenariosDir, id), { recursive: true, force: true });
    }
    await removeRunExports(rootDir, stateDir, run.runId, messagesOutputRel);
  }

  // --- The age rule ---
  let unownedRemoved = 0;
  const cutoff = now.getTime() - policy.adHocDays * 24 * 60 * 60 * 1000;

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

  const scenarioEntries: DatedEntry[] = [];
  for (const id of await listDirectories(scenariosDir)) {
    if (ownedScenarios.has(id)) continue;
    scenarioEntries.push({ id, at: await mtimeOf(path.join(scenariosDir, id)) });
  }
  for (const id of planAgeRetention(scenarioEntries, cutoff)) {
    await rm(path.join(scenariosDir, id), { recursive: true, force: true });
    unownedRemoved += 1;
  }

  const rankedIds = new Set(ranked.map((run) => run.runId));
  const runEntries: DatedEntry[] = [];
  for (const runId of await listDirectories(runsDir)) {
    if (rankedIds.has(runId)) continue;
    runEntries.push({ id: runId, at: await mtimeOf(path.join(runsDir, runId)) });
  }
  for (const runId of planAgeRetention(runEntries, cutoff)) {
    await removeRunExports(rootDir, stateDir, runId, messagesOutputRel);
    unownedRemoved += 1;
  }

  return {
    runsKept: ranked.length - dropped.size,
    runsRemoved: dropped.size,
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
      `${plural(outcome.unownedRemoved, "record", "records")} no retained run owns, older than ${plural(policy.adHocDays, "day", "days")} (retention.adHocDays)`,
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
    `A step record is removed once its run is older than the newest ${plural(policy.runs, "run", "runs")}, ` +
    `and a record no run owns once it is older than ${plural(policy.adHocDays, "day", "days")} ` +
    "(retention in nukadoko.config.ts)"
  );
}
