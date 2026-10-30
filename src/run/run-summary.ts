import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROOF_RUNS } from "../condition/condition.js";
import type { CountRange } from "../execution-events/count.js";
import { byGate, kindRule, PATH_KIND_ORDER, requestKey, type PathKey, type PathKind } from "../execution-events/path.js";
import type { TraceGap } from "../execution-events/tally.js";
import { whereOf, type Finding } from "../finding/finding.js";
import { runDir } from "../record/run-exports.js";
import {
  RED_VERDICTS,
  type RunClaim,
  type RunDocument,
  type RunPathComparison,
  type RunPathCriterion,
  type RunPathDifference,
  type RunPathStep,
  type RunRoute,
  type RunScenario,
  type RunTableCell,
  type RunTableRow,
  type RunWorld,
} from "../record/run-result.js";
import type { MeasuredChannel } from "../record/types.js";
import { claimLine } from "../report/summary/claim-line.js";
import { hookLabel } from "../report/summary/hook-label.js";
import { exitedProducers, firstErrorLine, formatSummaryDuration, type ExitedProducer } from "./progress-log.js";
import { cellText as cellWord, leftOutText } from "./verdict-table.js";

// Responsibility: the Markdown run summary one `nuka run` invocation leaves
// for a person: in its own run directory always, appended to
// `$GITHUB_STEP_SUMMARY` when that is set, and wherever
// `nuka report --format markdown` is pointed later. It says what ran, at which commit, under which condition, and how
// each criterion came out: the verdict table first, then why each red row
// is red. Under `nuka run --base` the table says what each criterion's
// change is, the line above it what the run compared with and whether the
// mapping changed, and a section after the reasons quotes each removed
// criterion, since head no longer holds its sentences. When the run
// compared the steps' paths of a pair of sides, a section lists what each
// criterion's program did differently on one side. When the program's
// execution events named a flag, a section counts each side's criteria.
//
// Only head's executions feed the sections after the table (claims,
// unmeasured actions, scenarios with no claim, reruns): an execution of
// the base or the old world is a cell of the table, read there, and its
// claims are about code or steps the change replaced.
//
// The renderer reads run.json and nothing else, so the summary is a view of
// the run's one record and can never say something run.json does not. The
// same function renders a run.json copied off a CI machine.
//
// A write failure here is a warning, never a run failure: the exit code is
// the run's verdict, and a summary that could not be written does not
// change what ran.

export const RUN_SUMMARY_FILE_NAME = "summary.md";

/** The first line of every summary, so a CI step can find and update the
 * comment it posted earlier instead of posting another one. */
export const RUN_SUMMARY_MARKER = "<!-- nukadoko:run -->";

interface SummaryFailure {
  /** `step "<text>"` or a hook's label: where the scenario failed. */
  readonly where: string;
  readonly errorLine: string;
  /** The failed step's record, or the scenario's evidence directory for a
   * hook failure; `null` when nothing was written. */
  readonly recordPath: string | null;
  /** The last command the failed step ran that did not exit 0. */
  readonly command?: string;
  /** The steps the failed step read from whose process exited nonzero. */
  readonly exited?: readonly ExitedProducer[];
}

// Text a reader sees outside a code span. The table parser removes a `\`
// that sits immediately before a `|`, and the inline parser then removes a
// `\` that sits before ASCII punctuation, so a single `\` written for the
// pipe leaves `\\|`, which renders as `|`. Doubling every `\` first makes
// `\\\|` render as `\|`. `<` would open an HTML tag in GitHub's renderer.
function cellText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

// A code span longer than any backtick run inside it, so an error message
// that quotes code cannot close it early. In a table, `|` still needs its
// backslash inside a code span. A code span shows any other `\` as itself,
// so those are left alone.
function cellCode(text: string): string {
  return codeSpan(text).replace(/\|/g, "\\|");
}

// A code span outside a table, where a `\` before `|` would show.
function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/** The findings the verdict table already shows: a failed scenario is its
 * cell, and a row with no required cell is its reason line. */
const TABLE_CODES: ReadonlySet<string> = new Set(["scenario-failed", "walk-stopped", "criterion-without-required-cell"]);
/** Head's executions: the base and the old world's are the table's. */
function headScenarios(document: RunDocument): readonly RunScenario[] {
  return document.scenarios.filter((scenario) => scenario.world === undefined);
}

/** A world as a line names it: its environment, and its tree when that is
 * not head's. */
function worldName(world: Pick<RunWorld, "name" | "tree">): string {
  return world.tree === undefined || world.tree === "head" ? world.name : `${world.name} (${world.tree})`;
}

function scenarioKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

/** Findings the scenario tables do not already show. */
function runFindings(document: RunDocument): readonly Finding[] {
  return document.findings.filter((finding) => !TABLE_CODES.has(finding.code));
}

/** Why a run in which no scenario that ran failed, failed. A world that did not start is
 * named with its log, since no scenario ran there and its log is where the
 * reason is; any other failure outside every scenario is a hook's or a
 * worker's, which the findings name. */
function outsideScenarios(document: RunDocument): string[] {
  const unstarted = (document.worlds ?? []).filter((world) => (world.tree ?? "head") === "head" && world.error !== null);
  if (unstarted.length === 0) {
    return [
      "No scenario that ran failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no scenario, " +
        "failed outside every scenario. The findings below name it.",
    ];
  }
  const sentences = ["No scenario that ran failed, but the run did."];
  for (const world of unstarted) {
    const log = world.log === null ? null : document.run_dir === undefined ? world.log : `${document.run_dir}/${world.log}`;
    sentences.push(
      `The program did not start for world ${world.name} (\`program-start-failed\`), so no scenario ran there` +
        `${log === null ? "." : `; its log is ${cellCode(log)}.`}`,
    );
  }
  const other = document.findings.some(
    (finding) => finding.severity === "failed" && finding.code !== "program-start-failed" && !TABLE_CODES.has(finding.code),
  );
  if (other) sentences.push("A BeforeAll or AfterAll hook, or a worker that wrote no scenario, also failed outside every scenario.");
  sentences.push("The findings below say why.");
  return [sentences.join(" ")];
}

// The counts are of rows, one per criterion, whatever the environments
// and repeats: the verdict word is what a row comes to across its cells.
function renderTitle(document: RunDocument): string[] {
  const rows = document.table.rows;
  const count = (verdict: RunTableRow["verdict"]): number => rows.filter((row) => row.verdict === verdict).length;
  const criteria = countOf(rows.length, "criterion", "criteria");
  const scope = document.environments.length > 1 ? `${criteria} in ${document.environments.length} environments` : criteria;
  const counts = [scope, `${count("held")} held`];
  for (const word of ["proven", "removed", "failed", "unproven", "moved"] as const) {
    if (count(word) > 0) counts.push(`${count(word)} ${word}`);
  }
  const lines = [`# nukadoko run ${document.verdict}: ${counts.join(", ")}`];
  if (document.walk !== undefined) lines.push("", walkSentence(document.walk));
  // A red row whose red cells all did not run says why in its reason, but
  // not where to look: a world that did not start names its log here. A row
  // red for a cell that ran, or for having no required cell, is the table's
  // own to explain.
  const explained = rows.some((row) => {
    if (row.verdict === "unproven" || row.verdict === "moved") return true;
    if (row.verdict !== "failed") return false;
    const required = row.cells.filter((cell) => cell.role === "required");
    return required.length === 0 || required.some((cell) => cell.outcome !== "pass" && cell.outcome !== "not-run");
  });
  if (document.verdict === "failed" && !explained) lines.push("", ...outsideScenarios(document));
  return lines;
}

function renderCondition(document: RunDocument): string[] {
  const commit =
    document.commit === null
      ? "- commit: unknown (no git state was readable when the run started)"
      : `- commit: \`${document.commit.sha.slice(0, 7)}\`${document.commit.dirty ? " with uncommitted changes" : ""}`;
  const environments = document.environments.map((environment) => {
    const at = environment.base_url === undefined || environment.base_url === null ? "" : ` at ${environment.base_url}`;
    const declared = environment.conditions === undefined ? [] : [`conditions ${conditionsText(environment.conditions)}`];
    const version = environment.target_version === null ? [] : [`target version ${environment.target_version}`];
    const notes = [...declared, ...version];
    return `- environment: ${environment.name}${at}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
  });
  // Once per world, so a reader of an empty slice knows why it is empty.
  // Decided from the whole log when the world stopped: a log with no line
  // that carries a trace id of the world does not tag its lines, and a
  // log with lines that came after their step ended says how many. Why
  // they came late is not known, so it is only offered as a possibility,
  // and only when no line of the world came in time, the pattern a
  // program that buffers its output on a pipe makes.
  const programLogs = (document.worlds ?? []).flatMap((world) => {
    const log = world.program_log;
    if (log === null) {
      return [`- program log of world ${worldName(world)}: not read, since the program runs at ${world.url ?? "a URL"}, which nukadoko did not start`];
    }
    if (log === undefined || log.stamped === 0) return [];
    if (log.tagged === 0) return [`- program log of world ${worldName(world)}: carries no trace ids, so each step's slice of it is empty`];
    if (log.late > 0) {
      const fact = `- program log of world ${worldName(world)}: ${countOf(log.late, "line", "lines")} carrying a step's trace id arrived after that step ended (\`program-log-late.txt\`).`;
      if (log.lines > 0) return [fact];
      return [
        `${fact} None of the steps' lines arrived in time, which is what a program that buffers its output on a pipe looks like; ` +
          "if that is the cause, set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python.",
      ];
    }
    return [];
  });
  // Once per world whose program file names {events}, and per world at a
  // URL, only for what a reader of a step's events has to know: that the
  // file was not read, that the program wrote no line to it, or what of it
  // no step's record holds.
  const events = (document.worlds ?? []).flatMap((world) => {
    const read = world.events;
    if (read === undefined) return [];
    const head = `- events of world ${worldName(world)}:`;
    if (read === null) return [`${head} not read, since the program runs at ${world.url ?? "a URL"}, which nukadoko did not start`];
    if (read.lines === 0) return [`${head} the program wrote no line to the file {events} names, so no step's record has an event`];
    const undefinedKinds = Object.entries(read.undefined_kinds);
    const facts = [
      ...(read.late > 0 ? [`${countOf(read.late, "line", "lines")} carrying a step's trace id arrived after that step ended (\`events-late.jsonl\`)`] : []),
      ...(read.unreadable > 0 ? [`${countOf(read.unreadable, "line is", "lines are")} not one readable line of the format`] : []),
      ...(undefinedKinds.length > 0
        ? [`${countOf(undefinedKinds.reduce((total, [, count]) => total + count, 0), "line names", "lines name")} a kind the format does not define (${undefinedKinds.map(([kind]) => cellCode(kind)).join(", ")})`]
        : []),
    ];
    if (facts.length === 0) return [];
    const copy = read.file === null ? "the world's copy of the file could not be written" : `the whole file is in ${cellCode(read.file)}`;
    return [`${head} ${facts.join("; ")}; ${copy}`];
  });
  const browsers = new Map<string, string>();
  for (const scenario of document.scenarios) {
    if (scenario.browser !== undefined) {
      browsers.set(`${scenario.browser.type}\u0000${scenario.browser.version}`, `${scenario.browser.type} ${scenario.browser.version}`);
    }
  }
  const browser = browsers.size === 0 ? "- browser: none launched" : `- browser: ${[...browsers.values()].join(", ")}`;
  const selection =
    document.selection === "full"
      ? "- selection: full"
      : "- selection: partial (a line target left out other scenarios of its file)";
  // Only a count other than the default is said, as `proven` reads
  // with it: a control's `(n runs)` in the table is measured against it.
  const proofRuns =
    document.table.proof_runs === DEFAULT_PROOF_RUNS
      ? []
      : [`- proof runs: ${document.table.proof_runs} (\`--proof-runs\`: a control proves its row once it breaks the same claim at one Then line in ${document.table.proof_runs} runs)`];
  // Only a skipped check is said: a run whose check ran is the default, and
  // a finding of that check would have stopped it.
  const check =
    document.check === "skipped"
      ? ["- check: skipped (`nuka run --no-check`), so no finding of `nuka check` held this run back"]
      : [];
  const elapsed = Date.parse(document.finished_at) - Date.parse(document.started_at);
  return [
    "",
    commit,
    ...environments,
    ...programLogs,
    ...events,
    browser,
    selection,
    ...proofRuns,
    ...check,
    `- nukadoko: ${document.nukadoko}`,
    `- run: ${document.run_id}`,
    `- started ${document.started_at}, finished ${document.finished_at} (${formatSummaryDuration(elapsed)})`,
  ];
}

// A walk is a run that paused after each step for an answer: its verdicts
// were measured, but between steps the world and the browser were open to
// anything, which no record covers. The longest pause says how long that
// was.
function walkSentence(walk: NonNullable<RunDocument["walk"]>): string {
  const longest = Math.max(0, ...walk.pauses.map((pause) => Date.parse(pause.answered_at) - Date.parse(pause.paused_at)));
  const pauses = countOf(walk.pauses.length, "pause", "pauses");
  return (
    `Walked one step at a time (\`nuka run --step\`): ${pauses}, the longest ${formatSummaryDuration(longest)}. ` +
    "Between steps the world and the browser were open to anything, so this run is not the run a reviewer approves."
  );
}

function failedProcess(step: RunScenario["steps"][number]): string | undefined {
  const processes = step.observed?.processes ?? [];
  for (let index = processes.length - 1; index >= 0; index -= 1) {
    const entry = processes[index]!;
    if (entry.exit_code !== 0) return entry.command.join(" ");
  }
  return undefined;
}

function describeFailure(scenario: RunScenario): SummaryFailure | undefined {
  if (scenario.status === "stopped" && scenario.stopped !== undefined) {
    const last = scenario.steps[scenario.stopped.after_step - 1];
    return { where: `step "${last?.text ?? ""}"`, errorLine: "the walk was stopped after this step with nuka step stop", recordPath: last?.record ?? null };
  }
  const step = scenario.steps.find((entry) => entry.status !== "passed" && entry.status !== "skipped");
  if (step !== undefined) {
    const command = failedProcess(step);
    const exited = exitedProducers(step.used);
    return {
      where: `step "${step.text}"`,
      errorLine: firstErrorLine(step.error?.message ?? ""),
      recordPath: step.record,
      ...(exited.length === 0 ? {} : { exited }),
      ...(command === undefined ? {} : { command }),
    };
  }
  const hook = scenario.hooks.find((entry) => entry.status === "failed");
  if (hook !== undefined) {
    return { where: hookLabel(hook), errorLine: firstErrorLine(hook.error?.message ?? ""), recordPath: scenario.evidence?.dir ?? null };
  }
  return undefined;
}

// Where an execution stopped, as the list item under a red row's reason
// says it, outside the table.
function renderFailure(failure: SummaryFailure): string {
  const parts = [`${cellText(failure.where)}: ${codeSpan(failure.errorLine)}`];
  for (const producer of failure.exited ?? []) {
    parts.push(`used ${cellText(producer.step)} exit ${producer.exitCode}: ${codeSpan(producer.outputLine)}`);
  }
  if (failure.command !== undefined) parts.push(`ran ${codeSpan(failure.command)}`);
  if (failure.recordPath !== null) parts.push(`record ${codeSpan(failure.recordPath)}`);
  return parts.join("; ");
}

function conditionsText(conditions: Readonly<Record<string, boolean | string>>): string {
  const entries = Object.entries(conditions);
  // A string is quoted, so a value reads apart from the boolean it spells.
  return entries.length === 0 ? "none" : entries.map(([name, value]) => `${name}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`).join(", ");
}

// A cell as the table shows it: what it came to, and, beside it, that it is
// a control and how many runs it holds when more than one, since a control
// proves only with `--proof-runs` agreeing runs and the reader checks that
// count against the word.
function tableCell(cell: RunTableCell): string {
  const notes = [...(cell.role === "control" ? ["control"] : []), ...(cell.runs > 1 ? [`${cell.runs} runs`] : [])];
  return `${cellWord(cell)}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

// The verdict table (docs/spec.md "Verdicts"): a row per criterion, rows by
// feature path and line, so the same run reads the same way at any
// concurrency, and a column per world and environment, in the run's
// environment order. The verdict is the first column, since it is what a
// reader scans for. A head column's heading names the conditions its
// environment declares, since they decide which of its cells count, and
// they are the environment's word, which a reader can check. A base or an
// old column names none: a base cell takes its role from head's, and an
// old cell names on itself the conditions the ref gives its environment.
function renderTable(document: RunDocument): string[] {
  const { worlds, rows, base } = document.table;
  if (rows.length === 0) return [];
  const heading = (column: (typeof worlds)[number]): string => {
    const declared = column.world === "head" ? document.environments.find((environment) => environment.name === column.environment)?.conditions : undefined;
    return `${column.world} ${column.environment}${declared === undefined ? "" : ` (${conditionsText(declared)})`}`;
  };
  // The change column only under `--base`: without a base nothing is
  // known about it.
  const change = (row: RunTableRow): string[] => {
    if (base === null) return [];
    const renamed = row.renamed_from === undefined ? "" : `, renamed from ${cellCode(row.renamed_from.feature)} ${cellText(row.renamed_from.name)}`;
    return [`${row.change ?? ""}${renamed}${row.retagged === true ? ", retagged" : ""}`];
  };
  return [
    ...renderBase(document),
    "",
    `| verdict | criterion | ${base === null ? "" : "change | "}${worlds.map((column) => cellText(heading(column))).join(" | ")} |`,
    `| --- | --- | ${base === null ? "" : "--- | "}${worlds.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => {
      const tags = row.conditions.length === 0 ? "" : ` ${row.conditions.map((tag) => cellCode(tag)).join(" ")}`;
      const cells = worlds.map((column) => {
        const cell = row.cells.find((entry) => entry.world === column.world && entry.environment === column.environment);
        return cell === undefined ? "" : tableCell(cell);
      });
      return `| ${[row.verdict, `${cellCode(`${row.feature}:${row.line}`)} ${cellText(row.name)}${tags}`, ...change(row), ...cells].join(" | ")} |`;
    }),
    // A criterion `--env` left out has no row, so the table says how many
    // there were, or the run would read as covering the whole selection.
    ...(document.table.left_out > 0 ? ["", leftOutText(document.table.left_out)] : []),
  ];
}

// The line above the table under `--base`: what the run compared with, how
// many criteria changed, and whether the mapping changed and what in it,
// since an unchanged criterion over a changed mapping is what the old
// world was run for.
function renderBase(document: RunDocument): string[] {
  const { base, rows } = document.table;
  if (base === null) return [];
  const count = (change: RunTableRow["change"]): number => rows.filter((row) => row.change === change).length;
  const changes = `${count("unchanged")} unchanged, ${count("changed")} changed, ${count("new")} new, ${count("removed")} removed`;
  const mapping = document.table.mapping_changes;
  const parts = mapping === null
    ? []
    : [
        ...(mapping.files.length === 0 ? [] : [`${mapping.files.length === 1 ? "file" : "files"} ${mapping.files.map((file) => cellCode(file)).join(", ")}`]),
        ...(mapping.config ? ["the config's mapping part"] : []),
        ...(mapping.conditions.length === 0 ? [] : [`the conditions of ${mapping.conditions.map((name) => cellCode(name)).join(", ")}`]),
        ...(mapping.default_environments ? ["defaultEnvironments"] : []),
      ];
  const unseen = mapping?.unseen ?? [];
  // The old world can fail to start (a base config that does not load, a
  // program the base lacks), so the line says how many it ran rather than
  // that it ran each one. A row that failed at head needs no old world,
  // and a row counts as run only when every old cell it needed ran.
  const unchanged = rows.filter((row) => row.change === "unchanged" && row.verdict !== "failed");
  const ranOld = unchanged.filter((row) => {
    const old = row.cells.filter((cell) => cell.world === "old");
    return old.length > 0 && old.every((cell) => cell.outcome !== "not-run");
  }).length;
  const oldRan =
    ranOld === unchanged.length
      ? "so the old world ran each unchanged criterion under the base's steps."
      : `so each unchanged criterion needed the old world, but it ran ${ranOld === 0 ? "none of them" : `only ${ranOld} of the ${unchanged.length}`}; each moved row says why.`;
  const mappingLine =
    unseen.length > 0
      ? `The mapping could not be compared whole (${unseen.join("; ")}), so it counts as changed, and each unchanged criterion needs the old world.`
      : document.table.mapping_changed === true
        ? `The mapping changed (${parts.length === 0 ? "the base's could not be read" : parts.join("; ")}), ${oldRan}`
        : "The mapping did not change, so no unchanged criterion needed the old world.";
  // A ref that is itself an abbreviated hash would only repeat.
  const compared = base.commit.startsWith(base.ref) ? cellCode(base.ref) : `${cellCode(base.ref)} (\`${base.commit.slice(0, 7)}\`)`;
  return ["", `Compared with ${compared}: ${changes}. ${mappingLine}`];
}

// One line per red row, under the table: the reason the row is red, and,
// under it, where the first execution that did not pass stopped in the
// cell the reason names, with the error, the command, and the record a
// reader opens next. A held or proven row's reason is in run.json; its
// cells already say what it came to.
function renderReasons(document: RunDocument): string[] {
  const red = document.table.rows.filter((row) => RED_VERDICTS.has(row.verdict));
  if (red.length === 0) return [];
  const lines = [""];
  for (const row of red) {
    lines.push(`- ${codeSpan(`${row.feature}:${row.line}`)} ${cellText(row.name)}: ${cellText(row.reason)}`);
    // The cell the reason names: a required head cell for `failed`, an old
    // cell for `moved`, a base cell for `unproven`.
    const world = row.verdict === "moved" ? "old" : row.verdict === "unproven" ? "base" : "head";
    const cell = row.cells.find(
      (entry) => entry.world === world && entry.role === "required" && entry.outcome !== "pass" && entry.outcome !== "not-run",
    );
    const execution =
      cell === undefined
        ? undefined
        : document.scenarios.find((scenario) => {
            const at = scenario.row ?? { feature: scenario.feature, line: scenario.line };
            return (
              at.feature === row.feature &&
              at.line === row.line &&
              (scenario.world ?? "head") === world &&
              scenario.environment === cell.environment &&
              scenario.status !== "passed"
            );
          });
    const failure = execution === undefined ? undefined : describeFailure(execution);
    if (failure !== undefined) lines.push(`  - ${world === "head" ? "" : `${world}: `}${renderFailure(failure)}`);
  }
  return lines;
}

// Each criterion the base holds and head does not, with its sentences at
// the base: a reader approving the change sees what it drops.
function renderRemoved(document: RunDocument): string[] {
  const removed = document.table.rows.filter((row) => row.verdict === "removed");
  if (removed.length === 0) return [];
  const lines = ["", "## Removed criteria", "", "Each criterion below is in the base and not in head, quoted as the base has it."];
  for (const row of removed) {
    const text = row.lines ?? [];
    const longestRun = Math.max(2, ...text.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestRun + 1);
    lines.push("", `### ${cellCode(`${row.feature}:${row.line}`)} ${cellText(row.name)}`, "", `${fence}gherkin`, ...text, fence);
  }
  return lines;
}

// How many criteria one pair of sides lists before it counts the rest.
const PATHS_SHOWN = 20;

// Each kind of a path in words, one and many, in PATH_KINDS order.
const PATH_KIND_WORDS: Readonly<Record<PathKind, readonly [string, string]>> = {
  error: ["error", "errors"],
  db: ["write", "writes"],
  http: ["outgoing call", "outgoing calls"],
  job: ["job", "jobs"],
  request: ["request", "requests"],
  flag: ["flag", "flags"],
};

function programCode(value: string | number | boolean | null): string {
  return codeSpan(programWord(String(value)));
}

// What one entry of a path is, the program's own words in code spans.
function pathEntryText(key: PathKey): string {
  switch (key.kind) {
    case "error":
      return `${programCode(key.class)} ${key.handled ? "handled" : "unhandled"}`;
    case "db":
      return `${programCode(key.table)} ${key.op}`;
    case "http":
      return `${programCode(`${key.method} ${key.origin}${key.path}`)} ${key.status ?? "with no status"}`;
    case "job":
      return `${programCode(key.name)} ${key.phase}`;
    case "request":
      return `${programCode(`${key.method} ${key.route ?? "(no route)"}`)} ${key.status}`;
    case "flag":
      return `${programCode(key.name)} ${programCode(key.side)}`;
  }
}

function rangeWords(range: CountRange): string {
  if (range.at_most === null) return `${range.at_least} or more`;
  return range.at_most === range.at_least ? String(range.at_least) : `${range.at_least} to ${range.at_most}`;
}

// A flag compares as seen or not, so its range reads as whether the
// program evaluated it.
function seenWords(range: CountRange): string {
  if (range.at_least > 0) return "evaluated";
  return range.at_most === 0 ? "not evaluated" : "maybe evaluated";
}

function differenceText(difference: RunPathDifference): string {
  const words = kindRule(difference.kind).compare === "seen" ? seenWords : rangeWords;
  const holds = difference.holds === undefined ? "" : ` (${difference.holds})`;
  return `${pathEntryText(difference)} ${words(difference.a)} → ${words(difference.b)}${holds}`;
}

// A difference on a table the program marks as bookkeeping or
// infrastructure is listed after the rest, under a heading of its own, so
// a reader is sent first to what the criteria are about (src/run/path-view.ts).
function isMarked(difference: RunPathDifference): boolean {
  return difference.holds !== undefined;
}

type DifferenceOf<K extends PathKind> = RunPathDifference & { readonly kind: K };

// A route whose status changed, and a flag whose side did, read as one
// difference, what it is then the old value and the new, when every count
// on it is exact and as many went as came.
function switchTexts<D extends RunPathDifference>(differences: readonly D[], group: (difference: D) => string, what: (difference: D) => string, value: (difference: D) => string): string[] {
  const groups = new Map<string, D[]>();
  for (const difference of differences) groups.set(group(difference), [...(groups.get(group(difference)) ?? []), difference]);
  return [...groups.values()].flatMap((list) => {
    const gone = list.filter((difference) => difference.b.at_most === 0 && difference.a.at_most === difference.a.at_least);
    const came = list.filter((difference) => difference.a.at_most === 0 && difference.b.at_most === difference.b.at_least);
    const total = (of: readonly D[], side: "a" | "b"): number => of.reduce((sum, difference) => sum + difference[side].at_least, 0);
    if (gone.length === 0 || came.length === 0 || gone.length + came.length !== list.length || total(gone, "a") !== total(came, "b")) return list.map(differenceText);
    return [`${what(list[0]!)} ${gone.map(value).join(" and ")} → ${came.map(value).join(" and ")}`];
  });
}

function kindTexts(differences: readonly RunPathDifference[]): string[] {
  const requests = differences.filter((difference): difference is DifferenceOf<"request"> => difference.kind === "request");
  const flags = differences.filter((difference): difference is DifferenceOf<"flag"> => difference.kind === "flag");
  return [
    ...differences.filter((difference) => difference.kind !== "request" && difference.kind !== "flag").map(differenceText),
    ...switchTexts(requests, (request) => JSON.stringify([request.method, request.route]), (request) => programCode(`${request.method} ${request.route ?? "(no route)"}`), (request) => String(request.status)),
    ...switchTexts(flags, (flag) => flag.name, (flag) => programCode(flag.name), (flag) => programCode(flag.side)),
  ];
}

// The differences of one step by kind, in rank order: `writes \`rooms\` update 0 → 1; requests ...`.
function differencesText(differences: readonly RunPathDifference[]): string {
  return PATH_KIND_ORDER.flatMap((kind) => {
    const of = differences.filter((difference) => difference.kind === kind);
    return of.length === 0 ? [] : [`${PATH_KIND_WORDS[kind][1]} ${kindTexts(of).join(", ")}`];
  }).join("; ");
}

function gapWords(gaps: readonly TraceGap[]): string {
  return gaps
    .map((gap) => {
      const word = codeSpan(gap.gap);
      if (gap.gap === "jobs-pending") return `${word} ${countOf(gap.job_ids.length, "job", "jobs")}`;
      if (gap.gap === "request-unreported") return `${word} ${countOf(gap.requests, "request", "requests")}`;
      if (gap.gap === "unreadable") return `${word} ${countOf(gap.lines, "line", "lines")}`;
      return word;
    })
    .join(", ");
}

// Who leaves an open difference open: the sides that are not whole, or
// lines on a whole side that may be any line.
function openWhy(gaps: { readonly a: readonly TraceGap[]; readonly b: readonly TraceGap[] }, sideName: (side: "a" | "b") => string): string {
  if (gaps.a.length > 0 && gaps.b.length > 0) return `neither side is whole (${sideName("a")}: ${gapWords(gaps.a)}; ${sideName("b")}: ${gapWords(gaps.b)})`;
  if (gaps.a.length > 0) return `${sideName("a")} is not whole (${gapWords(gaps.a)})`;
  if (gaps.b.length > 0) return `${sideName("b")} is not whole (${gapWords(gaps.b)})`;
  return "a line on a side may be any line";
}

function lineWords(lines: readonly (number | null)[]): string {
  const known = lines.map((line) => (line === null ? "?" : String(line)));
  return known.length === 1 ? `line ${known[0]}` : `lines ${known[0]} to ${known.at(-1)}`;
}

interface PathReading {
  readonly comparison: RunPathComparison;
  readonly scenarios: ReadonlyMap<string, RunScenario>;
  /** `the base` and `head` against the base; an environment's name
   * between two environments. */
  readonly sideName: (side: "a" | "b") => string;
  /** Where a side ran: `at the base`, `at head`, or in its environment. */
  readonly sideWhere: (side: "a" | "b") => string;
  /** Whether a kind is compared in this pair: the premise of a pair of
   * environments is not. */
  readonly compared: (kind: PathKind) => boolean;
}

function pathReading(comparison: RunPathComparison, scenarios: ReadonlyMap<string, RunScenario>): PathReading {
  const base = comparison.between.kind === "base";
  return {
    comparison,
    scenarios,
    sideName: (side) => (base ? (side === "a" ? "the base" : "head") : codeSpan(comparison[side].environment)),
    sideWhere: (side) => (base ? (side === "a" ? "at the base" : "at head") : `in ${codeSpan(comparison[side].environment)}`),
    compared: (kind) => base || kindRule(kind).conditionPremise !== true,
  };
}

// What the steps that ran on one side only did there, counted by kind in
// rank order: `2 writes, 1 request`. A step with no path adds nothing.
function oneSideKinds(reading: PathReading, criterion: RunPathCriterion, steps: readonly RunPathStep[], side: "a" | "b"): Map<PathKind, number> {
  const scenario = reading.scenarios.get(criterion[side].scenario_record_id);
  const counts = new Map<PathKind, number>();
  for (const step of steps) {
    const found = scenario?.steps.find((entry) => entry.line === step.line && entry.text === step.text)?.path;
    if (found === undefined) continue;
    for (const entry of [...found.entries, ...found.requests.map((request) => ({ ...requestKey(request), count: 1 }))]) {
      if (!reading.compared(entry.kind)) continue;
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + (kindRule(entry.kind).compare === "seen" ? 1 : entry.count));
    }
  }
  return counts;
}

// A criterion's step lines, of the differences `marked` picks out: those
// on a marked table, or every other.
function stepLines(reading: PathReading, criterion: RunPathCriterion, marked: boolean): string[] {
  return (criterion.steps ?? []).flatMap((step) => {
    if (step.ran !== "both") return [];
    const changed = step.changed.filter((difference) => isMarked(difference) === marked);
    const open = step.open.filter((difference) => isMarked(difference) === marked);
    const parts = [
      ...(changed.length > 0 ? [differencesText(changed)] : []),
      ...(open.length > 0 ? [`open, since ${openWhy(step.gaps, reading.sideName)}: ${differencesText(open)}`] : []),
    ];
    return parts.length === 0 ? [] : [`  - line ${step.line ?? "?"} ${codeSpan(step.text)}: ${parts.join("; ")}`];
  });
}

function criterionLines(reading: PathReading, criterion: RunPathCriterion): string[] {
  const steps = criterion.steps ?? [];
  const lines = stepLines(reading, criterion, false);
  const oneSide = steps.filter((step) => step.ran !== "both");
  if (oneSide.length > 0) {
    const ran = oneSide[0]!.ran as "a" | "b";
    const other = ran === "a" ? "b" : "a";
    const stopped = criterion[other];
    const where = stopped.line === undefined ? `, since ${reading.sideName(other)} did not run ${oneSide.length === 1 ? "it" : "them"}` : `, since ${reading.sideName(other)} stopped at line ${stopped.line} (${codeSpan(cellWord(stopped))})`;
    const counts = oneSideKinds(reading, criterion, oneSide, ran);
    const did = PATH_KIND_ORDER.flatMap((kind) => (counts.has(kind) ? [countOf(counts.get(kind)!, ...PATH_KIND_WORDS[kind])] : []));
    lines.push(`  - ${lineWords(oneSide.map((step) => step.line))} ran only ${reading.sideWhere(ran)}${where}: ${did.length === 0 ? "no execution event" : did.join(", ")}`);
  }
  return lines;
}

// A criterion whose open counts read the same on both sides, in one line:
// the gap words that leave them open, which both sides share.
function sameSoFarText(criterion: RunPathCriterion): string {
  const words = [...new Set((criterion.steps ?? []).flatMap((step) => (step.ran === "both" ? step.gaps.a.map((gap) => gap.gap) : [])))];
  return words.length === 0 ? "the same so far, with lines on both sides that may be any line" : `the same so far, with ${words.map(codeSpan).join(", ")} on both sides`;
}

// A criterion ranks by the highest kind among its decided differences and
// what its one-side steps did, so what persists outside the process comes
// first; then by the table's order, which the criteria already hold.
function pathRank(reading: PathReading, criterion: RunPathCriterion): number {
  const steps = criterion.steps ?? [];
  const oneSide = steps.filter((step) => step.ran !== "both");
  const kinds = [
    ...steps.flatMap((step) => (step.ran === "both" ? step.changed.filter((difference) => !isMarked(difference)).map((difference) => difference.kind) : [])),
    ...(oneSide.length === 0 ? [] : [...oneSideKinds(reading, criterion, oneSide, oneSide[0]!.ran as "a" | "b").keys()]),
  ];
  return Math.min(PATH_KIND_ORDER.length, ...kinds.map((kind) => PATH_KIND_ORDER.indexOf(kind)));
}

function conditionValue(value: boolean | string | null): string {
  if (value === null) return "not declared";
  return typeof value === "boolean" ? String(value) : codeSpan(programWord(value));
}

function pathHeading(comparison: RunPathComparison): string {
  const { between } = comparison;
  if (between.kind === "base") return "### base → head";
  return `### ${codeSpan(comparison.a.environment)} → ${codeSpan(comparison.b.environment)} (${codeSpan(between.name)} ${conditionValue(between.a)} → ${conditionValue(between.b)})`;
}

// A criterion's results, from the one that says most to the one that
// says least, with their words in a count line.
const PATH_RESULTS: readonly (readonly [RunPathCriterion["result"], string])[] = [
  ["changed", "changed"],
  ["open", "open"],
  ["same_so_far", "the same so far"],
  ["marked_only", "different only in bookkeeping or infrastructure writes"],
  ["same", "the same"],
];

function resultRank(result: RunPathCriterion["result"]): number {
  return PATH_RESULTS.findIndex(([entry]) => entry === result);
}

// The comparisons under one heading: a pair of environments alone, or
// every environment's base pair. Each criterion counts once, as what it
// came to where it says most, and one listed with the same lines in
// several base pairs is listed once, naming their environments.
function renderPathSection(document: RunDocument, comparisons: readonly RunPathComparison[]): string[] {
  const heading = pathHeading(comparisons[0]!);
  const named = (environments: readonly string[]): string => environments.map(codeSpan).join(", ");
  const place = (entry: { readonly feature: string; readonly line: number }): string => `${entry.feature}:${entry.line}`;
  const read = comparisons.filter((comparison) => comparison.unread === null);
  const unread = new Map<string, string[]>();
  for (const comparison of comparisons) if (comparison.unread !== null) unread.set(comparison.unread, [...(unread.get(comparison.unread) ?? []), comparison.b.environment]);
  const unreadText = [...unread].map(([reason, environments]) => (read.length === 0 && unread.size === 1 ? `Not compared: ${reason}.` : `Not compared in ${named(environments)}: ${reason}.`));
  if (read.length === 0) return ["", heading, "", unreadText.join(" ")];

  const results = new Map<string, RunPathCriterion["result"]>();
  for (const criterion of read.flatMap((comparison) => comparison.criteria)) {
    const was = results.get(place(criterion));
    if (was === undefined || resultRank(criterion.result) < resultRank(was)) results.set(place(criterion), criterion.result);
  }
  const said = PATH_RESULTS.flatMap(([result, word]) => {
    const n = [...results.values()].filter((entry) => entry === result).length;
    return n === 0 ? [] : [`${n} ${word}`];
  });
  const compared = results.size === 0 ? "No criterion was compared." : `${countOf(results.size, "criterion", "criteria")} compared: ${said.join(", ")}.`;
  const reasons = new Map<string, Set<string>>();
  for (const entry of read.flatMap((comparison) => comparison.not_compared)) {
    if (results.has(place(entry)) || [...reasons.values()].some((places) => places.has(place(entry)))) continue;
    reasons.set(entry.reason, (reasons.get(entry.reason) ?? new Set()).add(place(entry)));
  }
  const notCompared = [...reasons].map(([reason, places]) => ` ${countOf(places.size, "criterion", "criteria")} ${reason}, so ${places.size === 1 ? "its path was" : "their paths were"} not compared.`);

  const scenarios = new Map(document.scenarios.map((scenario) => [scenario.scenario_record_id, scenario]));
  const rowOrder = new Map(document.table.rows.map((row, index) => [place(row), index]));
  type Item = { readonly criterion: RunPathCriterion; readonly rank: number; readonly lines: readonly string[]; readonly environments: string[] };
  const items = new Map<string, Item>();
  // The differences on marked tables, criterion by criterion, listed after
  // the rest.
  const asides = new Map<string, Item>();
  for (const comparison of read) {
    const reading = pathReading(comparison, scenarios);
    for (const criterion of comparison.criteria) {
      const marked = stepLines(reading, criterion, true);
      if (marked.length > 0) {
        const key = JSON.stringify([place(criterion), marked]);
        const aside = asides.get(key) ?? { criterion, rank: 0, lines: marked, environments: [] };
        aside.environments.push(comparison.b.environment);
        asides.set(key, aside);
      }
      if (criterion.result === "same" || criterion.result === "marked_only") continue;
      const lines = criterion.result === "same_so_far" ? [sameSoFarText(criterion)] : criterionLines(reading, criterion);
      const key = JSON.stringify([place(criterion), lines]);
      const item = items.get(key) ?? { criterion, rank: pathRank(reading, criterion), lines, environments: [] };
      item.environments.push(comparison.b.environment);
      items.set(key, item);
    }
  }
  const sameSoFar = (item: { readonly criterion: RunPathCriterion }): number => Number(item.criterion.result === "same_so_far");
  const listed = [...items.values()].sort((x, y) => sameSoFar(x) - sameSoFar(y) || x.rank - y.rank || (rowOrder.get(place(x.criterion)) ?? 0) - (rowOrder.get(place(y.criterion)) ?? 0));
  const lines = ["", heading, "", [`${compared}${notCompared.join("")}`, ...unreadText].join(" ")];
  if (listed.length > 0) lines.push("");
  for (const { criterion, lines: said, environments } of listed.slice(0, PATHS_SHOWN)) {
    const head = `- ${cellCode(place(criterion))} ${cellText(criterion.name)}${read.length > 1 ? `, in ${named(environments)}` : ""}`;
    lines.push(...(criterion.result === "same_so_far" ? [`${head}: ${said[0]}`] : [head, ...said]));
  }
  if (listed.length > PATHS_SHOWN) lines.push(`- and ${listed.length - PATHS_SHOWN} more in run.json's \`paths\``);
  const aside = [...asides.values()].sort((x, y) => (rowOrder.get(place(x.criterion)) ?? 0) - (rowOrder.get(place(y.criterion)) ?? 0));
  if (aside.length > 0) {
    lines.push("", "Bookkeeping and infrastructure writes that differ, which no sentence is about, though another reader of those tables may be:", "");
    for (const { criterion, lines: said, environments } of aside.slice(0, PATHS_SHOWN)) {
      lines.push(`- ${cellCode(place(criterion))} ${cellText(criterion.name)}${read.length > 1 ? `, in ${named(environments)}` : ""}`, ...said);
    }
    if (aside.length > PATHS_SHOWN) lines.push(`- and ${aside.length - PATHS_SHOWN} more in run.json's \`paths\``);
  }
  return lines;
}

// run.json's `paths`, for the person who decides whether a change may be
// turned on for everyone: per pair of sides, each criterion whose program
// did something else on one side than on the other, step by step.
function renderPaths(document: RunDocument): string[] {
  const comparisons = document.paths ?? [];
  if (comparisons.length === 0) return [];
  return [
    "",
    "## Changed paths",
    "",
    "Each criterion below did something else on one side than on the other, or may have, step by step, as the program's execution events report it. " +
      "A count that a side's missing lines could still reach is listed as open, never as a change. " +
      "A criterion whose open counts read the same on both sides, under the same gaps, is the same so far, and comes last. " +
      "Between two environments, what they switch is named in the heading, so no flag's side is listed among the changes.",
    ...[comparisons.filter((comparison) => comparison.between.kind === "base"), ...comparisons.filter((comparison) => comparison.between.kind === "condition").map((comparison) => [comparison])]
      .filter((section) => section.length > 0)
      .flatMap((section) => renderPathSection(document, section)),
  ];
}

// How many unmeasured actions one line names before it counts the rest.
const UNMEASURED_SHOWN = 3;

function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const FLAG_VERDICTS = ["held", "proven", "failed", "unproven", "moved"] as const;

// A flag's name, side, and gate are the program's text, unlike a
// scenario's name, which Gherkin keeps to one line: a line break in one
// would end the list item, and the text after it could open a heading.
function programWord(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// One line per flag and side of run.json's `flags`, for the person who
// decides whether to turn a flag on: its counts, and the gates its lines
// named, or that no criterion evaluated a side the program's flags list
// declares. The criteria themselves are the table's rows above, so the
// line does not repeat them. A side alone of its flag says so, and a
// world whose flags list was not read is named, so a side missing from
// these lines is never read as one the program does not have.
function renderFlags(document: RunDocument): string[] {
  const rows = document.flags ?? [];
  const unread = (document.worlds ?? []).filter(
    (world) => (world.tree === undefined || world.tree === "head") && world.lists?.flags?.error !== undefined && world.lists.flags.error !== null,
  );
  if (rows.length === 0 && unread.length === 0) return [];
  const lines = rows.map((row) => {
    const flag = `- ${codeSpan(programWord(row.name))} ${codeSpan(programWord(row.side))}`;
    if (row.criteria.length === 0) return `${flag}, no criterion's steps evaluated it on this side`;
    const counts = FLAG_VERDICTS.filter((verdict) => row.counts[verdict] > 0).map((verdict) => `${row.counts[verdict]} ${verdict}`);
    if (row.counts.controls > 0) counts.push(`${row.counts.controls} only in controls`);
    const gates = [...new Set(row.criteria.flatMap((criterion) => criterion.cells.flatMap((cell) => cell.gates)))].sort(byGate);
    const named = gates.map((gate) => (gate === null ? "none named" : codeSpan(programWord(gate))));
    const counted = counts.length === 0 ? "" : `: ${counts.join(", ")}`;
    const tail = [
      ...(named.length === 0 ? [] : [`gates ${named.join(", ")}`]),
      ...(row.only_side_evaluated === true ? ["only this side was evaluated"] : []),
      ...(row.listed_in !== undefined && row.listed_in.length === 0 ? ["no flags list that was read declares this side"] : []),
    ];
    return `${flag}, ${countOf(row.criteria.length, "criterion", "criteria")}${counted}${tail.map((part) => `; ${part}`).join("")}`;
  });
  return [
    "",
    "## Flags",
    "",
    ...(rows.length === 0
      ? []
      : [
          "Each line counts the criteria whose steps evaluated the flag on the side the program's lines named, by their verdict in the table.",
          "One seen on that side only in controls is counted apart, since its verdict is about another side.",
          "",
        ]),
    ...lines,
    ...unread.map((world) => `- World ${codeSpan(programWord(world.name))} read no flags list (\`program-list-unread\` under Findings), so a side of a flag its steps never evaluated may not stand here.`),
  ];
}

// At most this many routes are named in one line of "Routes"; the rest
// are counted, and run.json's `routes` names every one.
const ROUTES_NAMED = 20;

function routeName(route: Pick<RunRoute, "method" | "route">): string {
  return codeSpan(programWord(route.route === null ? route.method : `${route.method} ${route.route}`));
}

function namedList(names: readonly string[]): string {
  const shown = names.slice(0, ROUTES_NAMED).join(", ");
  return names.length > ROUTES_NAMED ? `${shown}, and ${names.length - ROUTES_NAMED} more` : shown;
}

// The places of run.json's `routes` no step reached, for the reader who
// asks where nobody looked (docs/spec.md "Lists"): the listed routes no
// head step requested, split from those whose handler a request reached
// through another route (PUT and PATCH of one resource), then the
// requests the lists do not account for. A world whose list was not read
// is named, so its routes are never read as unrequested. The routes that
// were requested, with their criteria, are run.json's alone: a line each
// would repeat the table.
function renderRoutes(document: RunDocument): string[] {
  const heads = (document.worlds ?? []).filter((world) => world.tree === undefined || world.tree === "head");
  const unread = heads.filter((world) => world.lists?.routes?.error !== undefined && world.lists.routes.error !== null);
  const routes = document.routes ?? [];
  if (unread.length === 0 && document.routes === undefined) return [];
  const read = new Set(heads.filter((world) => world.lists?.routes?.error === null).map((world) => world.name));
  const listed = routes.filter((route) => route.listed_in.length > 0);
  const requested = listed.filter((route) => route.requests > 0);
  const through = new Map<string, RunRoute[]>();
  for (const route of routes) {
    if (route.requests === 0) continue;
    for (const handler of route.handlers) through.set(handler, [...(through.get(handler) ?? []), route]);
  }
  const gaps: string[] = [];
  const aliases: string[] = [];
  for (const route of listed) {
    if (route.requests > 0) continue;
    const others = route.handlers.flatMap((handler) => through.get(handler) ?? []);
    if (route.handlers.length > 0 && route.handlers.every((handler) => through.has(handler))) {
      aliases.push(`${routeName(route)} through ${[...new Set(others.map(routeName))].join(", ")}`);
    } else gaps.push(routeName(route));
  }
  // A request counts as one no list names only in a world whose list was
  // read: in another, nothing says whether its program has the route.
  const unlisted = routes.flatMap((route) => {
    if (route.route === null) return [];
    const requests = route.criteria.reduce(
      (total, criterion) => total + criterion.cells.reduce((sum, cell) => sum + (read.has(cell.environment) && !route.listed_in.includes(cell.environment) ? cell.requests : 0), 0),
      0,
    );
    return requests === 0 ? [] : [{ route, requests }];
  });
  const unmatched = routes.filter((route) => route.route === null && route.requests > 0);
  // Worlds of one program usually list the same routes; naming each world's
  // list then reads as if they differed.
  const same = listed.every((route) => [...read].every((name) => route.listed_in.includes(name)));
  const lists =
    read.size === 1 ? "the program's routes list names" : same ? `the program's routes list names (the same in ${read.size} worlds)` : `the routes lists of ${read.size} worlds name`;
  const lines = [
    ...(document.routes === undefined
      ? []
      : [
          `Head steps requested ${requested.length} of the ${countOf(listed.length, "route", "routes")} ${lists}.`,
          "A request says which route the program matched, not that a step checked what it answered.",
          "",
        ]),
    ...(gaps.length === 0 ? [] : [`- Never requested (${gaps.length}): ${namedList(gaps)}`]),
    ...(aliases.length === 0 ? [] : [`- Never requested, though a route with its handler was (${aliases.length}): ${namedList(aliases)}`]),
    ...(unlisted.length === 0
      ? []
      : [
          `- ${countOf(
            unlisted.reduce((total, { requests }) => total + requests, 0),
            "request",
            "requests",
          )} to a route its world's list does not name: ${namedList(unlisted.map(({ route, requests }) => `${routeName(route)} ${requests}`))}`,
        ]),
    ...(unmatched.length === 0
      ? []
      : [
          `- ${countOf(
            unmatched.reduce((total, route) => total + route.requests, 0),
            "request",
            "requests",
          )} the program matched to no route: ${namedList(unmatched.map((route) => `${routeName(route)} ${route.requests}`))}`,
        ]),
    ...unread.map((world) => `- World ${codeSpan(programWord(world.name))} read no routes list (\`program-list-unread\` under Findings), so none of its routes stands here.`),
  ];
  return ["", "## Routes", "", ...(lines.at(-1) === "" ? lines.slice(0, -1) : lines)];
}

// The item that names what a step started after its record was written
// (docs/spec.md "Records"): those lines are in the step's own files, but
// its record was already final, so this line is the one place that says
// they exist, and names the file that holds the requests, which the
// record may not name.
function afterStepEndItem(step: RunScenario["steps"][number]): string | undefined {
  const late = step.after_step_end;
  if (late === undefined) return undefined;
  const parts = [
    ...(late.requests > 0 ? [`${countOf(late.requests, "request", "requests")} in ${cellCode(late.http ?? "http.jsonl")}`] : []),
    ...(late.processes > 0 ? [countOf(late.processes, "process", "processes")] : []),
  ];
  return parts.length === 0 ? undefined : `started after the step ended: ${parts.join(", ")}`;
}

// The item that names a step's lines of the program's log that arrived
// after its record was written (docs/spec.md "Trace context and the
// program's log"): the world's stop found them, and the record was
// already final.
function programLogLateItem(step: RunScenario["steps"][number]): string | undefined {
  const late = step.program_log_late;
  if (late === undefined) return undefined;
  const lines = countOf(late.lines, "line", "lines");
  return late.file === null
    ? `${lines} of the program's log after the step ended, which could not be written`
    : `${lines} of the program's log after the step ended, in ${cellCode(late.file)}`;
}

// The item that names a step's execution events that arrived after its
// record was written, the same way.
function eventsLateItem(step: RunScenario["steps"][number]): string | undefined {
  const late = step.events_late;
  if (late === undefined) return undefined;
  const lines = countOf(late.lines, "line", "lines");
  return late.file === null
    ? `${lines} of the program's events after the step ended, which could not be written`
    : `${lines} of the program's events after the step ended, in ${cellCode(late.file)}`;
}

// One line per step that did something nukadoko could not measure (the
// step record's `observed.unmeasured`), or that started an action after
// its record was written: a reader approving the run needs to know which
// steps' evidence has a gap, and nothing else is added for a step without
// one. A process started without `runCommand` names only its program and
// argument count, so the line says how to get it recorded. Under
// `--repeat` the same step with the same gap is one line, citing its
// first record.
function renderUnmeasured(document: RunDocument): string[] {
  const named = document.environments.length > 1;
  const lines = new Map<string, { readonly sortKey: [string, number]; readonly text: string }>();
  let anyLateLog = false;
  let anyLateEvents = false;
  for (const scenario of headScenarios(document)) {
    for (const step of scenario.steps) {
      const unmeasured = step.observed?.unmeasured ?? [];
      const late = afterStepEndItem(step);
      const lateLog = programLogLateItem(step);
      if (lateLog !== undefined) anyLateLog = true;
      const lateEvents = eventsLateItem(step);
      if (lateEvents !== undefined) anyLateEvents = true;
      if (unmeasured.length === 0 && late === undefined && lateLog === undefined && lateEvents === undefined) continue;
      const shown = unmeasured.slice(0, UNMEASURED_SHOWN).map((entry) => `${entry.kind.replace("_", " ")} ${cellCode(entry.detail)}`);
      if (unmeasured.length > UNMEASURED_SHOWN) shown.push(`and ${unmeasured.length - UNMEASURED_SHOWN} more`);
      if (late !== undefined) shown.push(late);
      if (lateLog !== undefined) shown.push(lateLog);
      if (lateEvents !== undefined) shown.push(lateEvents);
      const where = `${scenario.feature}:${step.line ?? scenario.line}`;
      const environment = named ? ` (${cellText(scenario.environment)})` : "";
      const hint = unmeasured.some((entry) => entry.kind === "child_process") ? "; start a process with `runCommand` to record it" : "";
      const head = `- ${cellCode(where)} ${cellText(step.text)}${environment}: ${shown.join(", ")}${hint}`;
      if (lines.has(head)) continue;
      lines.set(head, {
        sortKey: [scenario.feature, step.line ?? scenario.line],
        text: step.record === null ? head : `${head}; record ${cellCode(step.record)}`,
      });
    }
  }
  if (lines.size === 0) return [];
  const sorted = [...lines.values()].sort((a, b) => a.sortKey[0].localeCompare(b.sortKey[0]) || a.sortKey[1] - b.sortKey[1]);
  return [
    "",
    "## Unmeasured actions",
    "",
    "Each step below did something nukadoko records but cannot measure, so its record has no evidence of what that action did.",
    "An action a step started after its record was written is in that step's own files, marked `after_step_end`, and not in its record.",
    ...(anyLateLog
      ? ["A line of the program's log that carries a step's trace id and arrived after its record was written is in that step's `program-log-late.txt`, and not in its record."]
      : []),
    ...(anyLateEvents
      ? ["A line of the program's events that carries a step's trace id and arrived after its record was written is in that step's `events-late.jsonl`, and not in its record."]
      : []),
    "",
    ...sorted.map((line) => line.text),
  ];
}

// One line per scenario in which no claim on a Then line was judged
// (run.json's `judged_by`): it passed or failed without a Then judging a
// claim, which a reader approving the run has to see beside the green.
// Under `--repeat` or several environments the scenario is one line.
function renderUnjudged(document: RunDocument): string[] {
  const lines = new Map<string, { readonly sortKey: [string, number]; readonly text: string }>();
  for (const scenario of headScenarios(document)) {
    if (scenario.judged_by === undefined) continue;
    const key = scenarioKey(scenario.feature, scenario.line);
    if (lines.has(key)) continue;
    const why =
      scenario.judged_by === "compat"
        ? "no claim judged it, and a compat step in Then position may have, by throwing or not, where nukadoko cannot see what it checked"
        : "no claim on a Then line was judged in it";
    lines.set(key, {
      sortKey: [scenario.feature, scenario.line],
      text: `- ${cellCode(`${scenario.feature}:${scenario.line}`)} ${cellText(scenario.scenario)}: ${why}`,
    });
  }
  if (lines.size === 0) return [];
  const sorted = [...lines.values()].sort((a, b) => a.sortKey[0].localeCompare(b.sortKey[0]) || a.sortKey[1] - b.sortKey[1]);
  return ["", "## Scenarios with no claim", "", "In each scenario below, no claim on a Then line was judged (held, broken, or unjudged).", "", ...sorted.map((line) => line.text)];
}

function channelText(measured: MeasuredChannel | null | undefined, ownRecordId: string | null): string {
  if (measured === null || measured === undefined) return "none";
  return measured.step_record_id === ownRecordId ? measured.channel : `${measured.channel} of ${measured.step_record_id}`;
}

// Where a claim's actual value was measured, beside the claim: a value no
// recorded channel holds is what a constant in step code looks like, so
// the line says `measured: none` for a reader to weigh. An expected value
// an earlier step returned or `observe` read gets the same, as `expected
// measured`: a When step that returns the value its Then compares with is
// a constant on the expected side. An `each` names each declaration that
// has one. A claim that read nothing has no value to have measured.
function measuredText(claim: RunClaim, ownRecordId: string | null): string {
  if (claim.outcome === "unobserved") return "";
  const actual = `; measured: ${channelText(claim.measured, ownRecordId)}`;
  const has = (entry: object): entry is { readonly expected_measured: MeasuredChannel | null } => Object.hasOwn(entry, "expected_measured");
  if (!("each" in claim)) return has(claim) ? `${actual}; expected measured: ${channelText(claim.expected_measured, ownRecordId)}` : actual;
  const declared = [
    ...(claim.each.where ?? []).map((entry, index) => [`where[${index}]`, entry] as const),
    ...claim.each.claims.map((entry, index) => [`claims[${index}]`, entry] as const),
  ].flatMap(([name, entry]) => (has(entry) ? [`${name} ${channelText(entry.expected_measured, ownRecordId)}`] : []));
  return declared.length === 0 ? actual : `${actual}; expected measured: ${declared.join(", ")}`;
}

// A claim on a count of execution events the world's stop judged
// otherwise was judged on lines still on their way: its line says what
// the whole count came to, since its outcome proves nothing.
function afterWorldStopText(claim: RunClaim): string {
  const after = "each" in claim ? undefined : claim.after_world_stop;
  return after === undefined || after.outcome === claim.outcome ? "" : `; after the world stopped, ${after.reason}, and the cell is broke`;
}

// One entry per Then that declared claims, and under it one line per claim
// (src/report/summary/claim-line.ts): what was compared, with what, where
// each value came from, and whether it held. A reader approving the run
// reads what each criterion measured here without opening a record. Under
// `--repeat`, a Then whose claims came out the same is one entry. A
// control's entry says so, since its broken claim is the proof a reader
// wants, not a failure to fix.
function renderClaims(document: RunDocument): string[] {
  const named = document.environments.length > 1;
  let anyControl = false;
  let anyLate = false;
  const entries = new Map<string, { readonly sortKey: [string, number]; readonly lines: readonly string[] }>();
  for (const scenario of headScenarios(document)) {
    for (const step of scenario.steps) {
      if (step.claims === undefined) continue;
      const where = `${scenario.feature}:${step.line ?? scenario.line}`;
      const control = scenario.role === "control";
      if (control) anyControl = true;
      const marks = [...(named ? [cellText(scenario.environment)] : []), ...(control ? ["control"] : [])];
      const environment = marks.length === 0 ? "" : ` (${marks.join(", ")})`;
      const attempts = step.attempts !== undefined && step.attempts > 1 ? `, ${step.attempts} readings` : "";
      const observation = step.observation === "unobserved" ? ", observed nothing" : "";
      const head = `- ${cellCode(where)} ${cellText(step.text)}${environment}${attempts}${observation}`;
      if (step.claims.some((claim) => afterWorldStopText(claim) !== "")) anyLate = true;
      const lines = [head, ...step.claims.map((claim) => `  - ${cellText(`${claimLine(claim)}${afterWorldStopText(claim)}${measuredText(claim, step.step_record_id)}`)}`)];
      const key = lines.join("\n");
      if (entries.has(key)) continue;
      entries.set(key, { sortKey: [scenario.feature, step.line ?? scenario.line], lines });
    }
  }
  if (entries.size === 0) return [];
  const sorted = [...entries.values()].sort((a, b) => a.sortKey[0].localeCompare(b.sortKey[0]) || a.sortKey[1] - b.sortKey[1]);
  return [
    "",
    "## Claims",
    "",
    "Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`." +
      (anyControl ? " An entry marked `control` is a control's: a claim it broke is evidence that the scenario tells the behaviour apart, not a failure." : "") +
      (anyLate ? " A claim on a count of execution events that the world's stop counted again and judged otherwise says what the whole count came to, after its outcome: it was judged on lines still on their way." : ""),
    "",
    ...sorted.flatMap((entry) => entry.lines),
  ];
}

function renderFindings(document: RunDocument): string[] {
  const findings = runFindings(document);
  if (findings.length === 0) return [];
  return [
    "",
    "## Findings",
    "",
    ...findings.map((finding) => `- ${finding.severity} \`${finding.code}\` ${cellText(whereOf(finding))}: ${cellText(finding.message)}`),
  ];
}

// The heading names what the commands under it rerun: a stopped walk did
// not fail, so a heading that called it failed would state something false.
function renderRerun(document: RunDocument): string[] {
  const commands = new Set<string>();
  let failed = false;
  let stopped = false;
  for (const scenario of headScenarios(document)) {
    if (scenario.do === undefined) continue;
    commands.add(scenario.do);
    if (scenario.status === "stopped") stopped = true;
    else failed = true;
  }
  if (commands.size === 0) return [];
  const what = failed && stopped ? "failed or stopped" : stopped ? "stopped" : "failed";
  return ["", `## Rerun a ${what} scenario`, "", "```sh", ...commands, "```"];
}

/** The summary of the run `document` records. */
export function renderRunSummary(document: RunDocument): string {
  const lines = [
    RUN_SUMMARY_MARKER,
    ...renderTitle(document),
    ...renderTable(document),
    ...renderReasons(document),
    ...renderCondition(document),
    ...renderRemoved(document),
    ...renderPaths(document),
    ...renderFlags(document),
    ...renderRoutes(document),
    ...renderClaims(document),
    ...renderUnjudged(document),
    ...renderUnmeasured(document),
    ...renderFindings(document),
    ...renderRerun(document),
  ];
  return `${lines.join("\n")}\n`;
}

export interface RunSummaryTargets {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly runId: string;
  /** `$GITHUB_STEP_SUMMARY`; appended, because earlier steps of the same
   * job write to the same file. */
  readonly stepSummaryPath: string | undefined;
}

export interface RunSummaryWriteResult {
  /** Root-relative path of the copy in the run directory, when written. */
  readonly runSummaryPath: string | null;
  readonly warnings: readonly string[];
}

export function writeRunSummaryFiles(markdown: string, targets: RunSummaryTargets): RunSummaryWriteResult {
  const warnings: string[] = [];
  const attempt = (label: string, write: () => void): boolean => {
    try {
      write();
      return true;
    } catch (error) {
      warnings.push(`Warning: the run summary was not written to ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const runCopy = path.join(runDir(targets.rootDir, targets.stateDir, targets.runId), RUN_SUMMARY_FILE_NAME);
  const wroteRunCopy = attempt(path.relative(targets.rootDir, runCopy), () => {
    mkdirSync(path.dirname(runCopy), { recursive: true });
    writeFileSync(runCopy, markdown);
  });
  if (targets.stepSummaryPath !== undefined) {
    const destination = targets.stepSummaryPath;
    attempt("GITHUB_STEP_SUMMARY", () => appendFileSync(destination, markdown));
  }
  return { runSummaryPath: wroteRunCopy ? path.relative(targets.rootDir, runCopy) : null, warnings };
}
