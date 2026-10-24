import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { whereOf, type Finding } from "../finding/finding.js";
import { runDir } from "../record/run-exports.js";
import type { RunClaim, RunDocument, RunScenario, RunTableCell, RunTableRow } from "../record/run-result.js";
import type { MeasuredChannel } from "../record/types.js";
import { claimLine } from "../report/summary/claim-line.js";
import { hookLabel } from "../report/summary/hook-label.js";
import { scenarioKey } from "./criteria-since.js";
import { exitedProducers, firstErrorLine, formatSummaryDuration, type ExitedProducer } from "./progress-log.js";
import { cellText as cellWord } from "./verdict-table.js";

// Responsibility: the Markdown run summary one `nuka run` invocation leaves
// for a person: in its own run directory always, appended to
// `$GITHUB_STEP_SUMMARY` when that is set, and wherever
// `nuka report --format markdown` is pointed later. It says what ran, at which commit, under which condition, and how
// each criterion came out: the verdict table first, then why each red row
// is red.
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

/** Findings the scenario tables do not already show. */
function runFindings(document: RunDocument): readonly Finding[] {
  return document.findings.filter((finding) => finding.code !== "scenario-failed");
}

/** Why a run in which no scenario that ran failed, failed. A world that did not start is
 * named with its log, since no scenario ran there and its log is where the
 * reason is; any other failure outside every scenario is a hook's or a
 * worker's, which the findings name. */
function outsideScenarios(document: RunDocument): string[] {
  const unstarted = (document.worlds ?? []).filter((world) => world.error !== null);
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
    (finding) => finding.severity === "failed" && finding.code !== "program-start-failed" && finding.code !== "scenario-failed",
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
  if (count("proven") > 0) counts.push(`${count("proven")} proven`);
  if (count("failed") > 0) counts.push(`${count("failed")} failed`);
  const lines = [`# nukadoko run ${document.verdict}: ${counts.join(", ")}`];
  // A red row whose red cells all did not run says why in its reason, but
  // not where to look: a world that did not start names its log here. A row
  // red for a cell that ran, or for having no required cell, is the table's
  // own to explain.
  const explained = rows.some((row) => {
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
      return [`- program log of world ${world.name}: not read, since the program runs at ${world.url ?? "a URL"}, which nukadoko did not start`];
    }
    if (log === undefined || log.stamped === 0) return [];
    if (log.tagged === 0) return [`- program log of world ${world.name}: carries no trace ids, so each step's slice of it is empty`];
    if (log.late > 0) {
      const fact = `- program log of world ${world.name}: ${countOf(log.late, "line", "lines")} carrying a step's trace id arrived after that step ended (\`program-log-late.txt\`).`;
      if (log.lines > 0) return [fact];
      return [
        `${fact} None of the steps' lines arrived in time, which is what a program that buffers its output on a pipe looks like; ` +
          "if that is the cause, set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python.",
      ];
    }
    return [];
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
    browser,
    selection,
    ...check,
    `- nukadoko: ${document.nukadoko}`,
    `- run: ${document.run_id}`,
    `- started ${document.started_at}, finished ${document.finished_at} (${formatSummaryDuration(elapsed)})`,
  ];
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
  return entries.length === 0 ? "none" : entries.map(([name, value]) => `${name}: ${String(value)}`).join(", ");
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
// reader scans for.
function renderTable(document: RunDocument): string[] {
  const { worlds, rows } = document.table;
  if (rows.length === 0) return [];
  return [
    "",
    `| verdict | criterion | ${worlds.map((column) => cellText(`${column.world} ${column.environment}`)).join(" | ")} |`,
    `| --- | --- | ${worlds.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => {
      const tags = row.conditions.length === 0 ? "" : ` ${row.conditions.map((tag) => cellCode(tag)).join(" ")}`;
      const cells = worlds.map((column) => {
        const cell = row.cells.find((entry) => entry.world === column.world && entry.environment === column.environment);
        return cell === undefined ? "" : tableCell(cell);
      });
      return `| ${row.verdict} | ${cellCode(`${row.feature}:${row.line}`)} ${cellText(row.name)}${tags} | ${cells.join(" | ")} |`;
    }),
  ];
}

// One line per red row, under the table: the reason the row is red, and,
// under it, where the first execution that did not pass stopped in the
// cell the reason names, with the error, the command, and the record a
// reader opens next. A held or proven row's reason is in run.json; its
// cells already say what it came to.
function renderReasons(document: RunDocument): string[] {
  const red = document.table.rows.filter((row) => row.verdict === "failed");
  if (red.length === 0) return [];
  const lines = [""];
  for (const row of red) {
    lines.push(`- ${codeSpan(`${row.feature}:${row.line}`)} ${cellText(row.name)}: ${cellText(row.reason)}`);
    const cell = row.cells.find((entry) => entry.role === "required" && entry.outcome !== "pass" && entry.outcome !== "not-run");
    const execution =
      cell === undefined
        ? undefined
        : document.scenarios.find(
            (scenario) => scenario.feature === row.feature && scenario.line === row.line && scenario.environment === cell.environment && scenario.status === "failed",
          );
    const failure = execution === undefined ? undefined : describeFailure(execution);
    if (failure !== undefined) lines.push(`  - ${renderFailure(failure)}`);
  }
  return lines;
}

// What moved in the criteria since `--since`'s ref, for the person who
// approved that base: one row per scenario (environments and repeats of it
// counted once), the text of each scenario that is not unchanged quoted in
// full, since that text is what they are asked to approve again, the
// criteria the ref held that are gone, and, under each step file that
// changed, every scenario that names it, unchanged ones included, since
// unchanged criteria over a changed step file is the case a reader would
// otherwise not see. It says what was compared, so a partial comparison is
// not read as the whole project's.
function renderCriteriaSince(document: RunDocument): string[] {
  const since = document.since;
  if (since === undefined || since === null) return [];
  const byScenario = new Map<string, RunScenario>();
  for (const scenario of document.scenarios) {
    const key = scenarioKey(scenario.feature, scenario.line);
    if (!byScenario.has(key)) byScenario.set(key, scenario);
  }
  const scenarios = [...byScenario.values()].sort((a, b) => a.feature.localeCompare(b.feature) || a.line - b.line);
  const count = (change: string): number => scenarios.filter((scenario) => scenario.criteria?.changed_since === change).length;
  const filesWith = (change: string): string[] => since.step_files.filter((entry) => entry.change === change).map((entry) => entry.file);
  const changedFiles = filesWith("changed");
  const untrackedFiles = filesWith("untracked");
  const counts = [
    `${count("unchanged")} unchanged`,
    `${count("changed")} changed`,
    `${count("new")} new`,
    `${since.removed.length} removed`,
    ...(count("ambiguous") > 0 ? [`${count("ambiguous")} ambiguous`] : []),
    ...(count("unknown") > 0 ? [`${count("unknown")} not compared`] : []),
  ];
  const fenced = (text: readonly string[]): string[] => {
    const longestRun = Math.max(2, ...text.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestRun + 1);
    return [`${fence}gherkin`, ...text, fence];
  };
  const lines = [
    "",
    `## Criteria since ${cellCode(since.ref)} (\`${since.commit.slice(0, 7)}\`)`,
    "",
    `${counts.join(", ")}.`,
    `Compared: the feature files in ${since.compared.map((target) => cellCode(target)).join(", ")} at the ref and in the working tree; a feature file outside them is not compared.`,
    "Step files compared: the files that register the bound steps, the files of their parts, and the config file when a step needs a fixture it defines, not the files those import.",
    changedFiles.length === 0 ? "No step file changed." : `Step files changed: ${changedFiles.map((file) => cellCode(file)).join(", ")}.`,
    ...(untrackedFiles.length === 0 ? [] : [`Not in the ref's commit: ${untrackedFiles.map((file) => cellCode(file)).join(", ")}.`]),
  ];
  const headings: Record<string, string> = { changed: "Changed", new: "New", ambiguous: "Ambiguous", unknown: "Not compared" };
  for (const scenario of scenarios) {
    const change = scenario.criteria?.changed_since;
    if (change === undefined || change === null || change === "unchanged") continue;
    lines.push("", `### ${headings[change]}: ${cellCode(`${scenario.feature}:${scenario.line}`)} ${cellText(scenario.scenario)}`, "");
    if (scenario.criteria?.reason !== undefined) lines.push(`${cellText(scenario.criteria.reason)}.`, "");
    lines.push(...fenced(scenario.criteria?.lines ?? []));
  }
  for (const removed of since.removed) {
    const name = removed.rule === null ? removed.scenario : `${removed.rule} / ${removed.scenario}`;
    lines.push("", `### Removed: ${cellCode(removed.feature)} ${cellText(name)}`, "", ...fenced(removed.lines));
  }
  for (const file of [...changedFiles, ...untrackedFiles]) {
    lines.push("", `### Step file ${changedFiles.includes(file) ? "changed" : "not in the ref's commit"}: ${cellCode(file)}`, "");
    for (const scenario of scenarios) {
      if (!(scenario.criteria?.step_files ?? []).includes(file)) continue;
      lines.push(`- ${cellCode(`${scenario.feature}:${scenario.line}`)} ${cellText(scenario.scenario)}, criteria ${scenario.criteria?.changed_since === "unknown" ? "not compared" : scenario.criteria?.changed_since}`);
    }
  }
  return lines;
}

// How many unmeasured actions one line names before it counts the rest.
const UNMEASURED_SHOWN = 3;

function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
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
  for (const scenario of document.scenarios) {
    for (const step of scenario.steps) {
      const unmeasured = step.observed?.unmeasured ?? [];
      const late = afterStepEndItem(step);
      const lateLog = programLogLateItem(step);
      if (lateLog !== undefined) anyLateLog = true;
      if (unmeasured.length === 0 && late === undefined && lateLog === undefined) continue;
      const shown = unmeasured.slice(0, UNMEASURED_SHOWN).map((entry) => `${entry.kind.replace("_", " ")} ${cellCode(entry.detail)}`);
      if (unmeasured.length > UNMEASURED_SHOWN) shown.push(`and ${unmeasured.length - UNMEASURED_SHOWN} more`);
      if (late !== undefined) shown.push(late);
      if (lateLog !== undefined) shown.push(lateLog);
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
  for (const scenario of document.scenarios) {
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

// One entry per Then that declared claims, and under it one line per claim
// (src/report/summary/claim-line.ts): what was compared, with what, where
// each value came from, and whether it held. A reader approving the run
// reads what each criterion measured here without opening a record. Under
// `--repeat`, a Then whose claims came out the same is one entry.
function renderClaims(document: RunDocument): string[] {
  const named = document.environments.length > 1;
  const entries = new Map<string, { readonly sortKey: [string, number]; readonly lines: readonly string[] }>();
  for (const scenario of document.scenarios) {
    for (const step of scenario.steps) {
      if (step.claims === undefined) continue;
      const where = `${scenario.feature}:${step.line ?? scenario.line}`;
      const environment = named ? ` (${cellText(scenario.environment)})` : "";
      const attempts = step.attempts !== undefined && step.attempts > 1 ? `, ${step.attempts} readings` : "";
      const observation = step.observation === "unobserved" ? ", observed nothing" : "";
      const head = `- ${cellCode(where)} ${cellText(step.text)}${environment}${attempts}${observation}`;
      const lines = [head, ...step.claims.map((claim) => `  - ${cellText(`${claimLine(claim)}${measuredText(claim, step.step_record_id)}`)}`)];
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
    "Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.",
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

function renderRerun(document: RunDocument): string[] {
  const commands = new Set<string>();
  for (const scenario of document.scenarios) {
    if (scenario.do !== undefined) commands.add(scenario.do);
  }
  if (commands.size === 0) return [];
  return ["", "## Rerun a failed scenario", "", "```sh", ...commands, "```"];
}

/** The summary of the run `document` records. */
export function renderRunSummary(document: RunDocument): string {
  const lines = [
    RUN_SUMMARY_MARKER,
    ...renderTitle(document),
    ...renderTable(document),
    ...renderReasons(document),
    ...renderCondition(document),
    ...renderCriteriaSince(document),
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
