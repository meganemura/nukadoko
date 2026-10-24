import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { whereOf, type Finding } from "../finding/finding.js";
import { runDir } from "../record/run-exports.js";
import type { RunDocument, RunScenario, RunVerdict } from "../record/run-result.js";
import { hookLabel } from "../report/summary/hook-label.js";
import { scenarioKey } from "./criteria-since.js";
import {
  exitedProducers,
  firstErrorLine,
  formatStepDuration,
  formatSummaryDuration,
  type ExitedProducer,
} from "./progress-log.js";

// Responsibility: the Markdown run summary one `nuka run` invocation leaves
// for a person: in its own run directory always, appended to
// `$GITHUB_STEP_SUMMARY` when that is set, and wherever
// `nuka report --format markdown` is pointed later. It says what ran, at which commit, under which condition, and how
// each scenario ended.
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
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded.replace(/\|/g, "\\|")}${fence}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Findings the scenario tables do not already show. */
function runFindings(document: RunDocument): readonly Finding[] {
  return document.findings.filter((finding) => finding.code !== "scenario-failed");
}

// The counts are of verdicts, one per scenario and environment: under
// `--repeat` a scenario that failed once has not passed, and under several
// environments one scenario is as many verdicts as environments.
function renderTitle(document: RunDocument): string[] {
  const failed = document.verdicts.filter((cell) => cell.verdict === "failed").length;
  const notRun = document.verdicts.filter((cell) => cell.verdict === "not-run").length;
  const passed = document.verdicts.length - failed - notRun;
  const rows = new Set(document.verdicts.map((cell) => scenarioKey(cell.feature, cell.line))).size;
  const scope =
    document.environments.length > 1
      ? `${plural(rows, "scenario")} in ${document.environments.length} environments`
      : plural(rows, "scenario");
  const counts = [scope, `${passed} passed`];
  if (failed > 0) counts.push(`${failed} failed`);
  if (notRun > 0) counts.push(`${notRun} not run`);
  const lines = [`# nukadoko run ${document.verdict}: ${counts.join(", ")}`];
  if (document.verdict === "failed" && failed === 0) {
    lines.push(
      "",
      "No scenario failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no scenario, " +
        "failed outside every scenario. The findings below name it.",
    );
  }
  return lines;
}

function renderCondition(document: RunDocument): string[] {
  const commit =
    document.commit === null
      ? "- commit: unknown (no git state was readable when the run started)"
      : `- commit: \`${document.commit.sha.slice(0, 7)}\`${document.commit.dirty ? " with uncommitted changes" : ""}`;
  const environments = document.environments.map((environment) => {
    const at = environment.base_url === undefined || environment.base_url === null ? "" : ` at ${environment.base_url}`;
    return environment.target_version === null
      ? `- environment: ${environment.name}${at}`
      : `- environment: ${environment.name}${at} (target version ${environment.target_version})`;
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
  const elapsed = Date.parse(document.finished_at) - Date.parse(document.started_at);
  return [
    "",
    commit,
    ...environments,
    browser,
    selection,
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

function renderFailureCell(failure: SummaryFailure | undefined): string {
  if (failure === undefined) return "";
  const parts = [`${cellText(failure.where)}: ${cellCode(failure.errorLine)}`];
  for (const producer of failure.exited ?? []) {
    parts.push(`used ${cellText(producer.step)} exit ${producer.exitCode}: ${cellCode(producer.outputLine)}`);
  }
  if (failure.command !== undefined) parts.push(`ran ${cellCode(failure.command)}`);
  if (failure.recordPath !== null) parts.push(`record ${cellCode(failure.recordPath)}`);
  return parts.join("<br>");
}

function durationOf(scenario: RunScenario): number {
  return Date.parse(scenario.finished_at) - Date.parse(scenario.started_at);
}

// What one cell of a scenario's row says: its verdict, or how many of its
// executions passed under `--repeat`.
function verdictCell(cell: RunVerdict | undefined): string {
  if (cell === undefined || cell.verdict === "not-run") return "not run";
  if (cell.executions === 1) return cell.verdict;
  return `${cell.passed} of ${cell.executions} passed`;
}

// One table per feature file, features by path and scenarios by line, so
// the same run reads the same way at any concurrency. A row is one
// scenario and a column is one environment, in the order `--env` gave
// them, so a scenario that passed in one environment and failed in another
// reads across one line. A row's duration sums every execution it holds,
// and its failure cell names the first failed execution in each failed
// environment, prefixed by that environment when there is more than one.
function renderFeatures(document: RunDocument): string[] {
  const environments = document.environments.map((environment) => environment.name);
  const named = environments.length > 1;
  const executions = new Map<string, RunScenario[]>();
  for (const scenario of document.scenarios) {
    const key = scenarioKey(scenario.feature, scenario.line);
    const rows = executions.get(key) ?? [];
    rows.push(scenario);
    executions.set(key, rows);
  }
  const byFeature = new Map<string, RunVerdict[][]>();
  const rowOf = new Map<string, RunVerdict[]>();
  for (const cell of document.verdicts) {
    const key = scenarioKey(cell.feature, cell.line);
    let row = rowOf.get(key);
    if (row === undefined) {
      row = [];
      rowOf.set(key, row);
      const rows = byFeature.get(cell.feature) ?? [];
      rows.push(row);
      byFeature.set(cell.feature, rows);
    }
    row.push(cell);
  }
  const lines: string[] = [];
  for (const feature of [...byFeature.keys()].sort()) {
    const rows = [...byFeature.get(feature)!].sort((a, b) => a[0]!.line - b[0]!.line);
    lines.push(
      "",
      `## ${cellText(feature)}`,
      "",
      `| scenario | line | ${environments.map(cellText).join(" | ")} | duration | failure |`,
      `| --- | --- | ${environments.map(() => "---").join(" | ")} | --- | --- |`,
    );
    for (const row of rows) {
      const first = row[0]!;
      const ran = executions.get(scenarioKey(first.feature, first.line)) ?? [];
      const cells = environments.map((environment) => verdictCell(row.find((cell) => cell.environment === environment)));
      const duration = ran.reduce((total, scenario) => total + durationOf(scenario), 0);
      const failures = environments.flatMap((environment) => {
        const failed = ran.find((scenario) => scenario.environment === environment && scenario.status === "failed");
        const failure = failed === undefined ? undefined : describeFailure(failed);
        if (failure === undefined) return [];
        const text = renderFailureCell(failure);
        return [named ? `${cellText(environment)}: ${text}` : text];
      });
      lines.push(
        `| ${cellText(first.scenario)} | ${first.line} | ${cells.join(" | ")} | ${formatStepDuration(duration)} | ${failures.join("<br>")} |`,
      );
    }
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

// `plural` above adds an s, which "process" does not take.
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
  for (const scenario of document.scenarios) {
    for (const step of scenario.steps) {
      const unmeasured = step.observed?.unmeasured ?? [];
      const late = afterStepEndItem(step);
      if (unmeasured.length === 0 && late === undefined) continue;
      const shown = unmeasured.slice(0, UNMEASURED_SHOWN).map((entry) => `${entry.kind.replace("_", " ")} ${cellCode(entry.detail)}`);
      if (unmeasured.length > UNMEASURED_SHOWN) shown.push(`and ${unmeasured.length - UNMEASURED_SHOWN} more`);
      if (late !== undefined) shown.push(late);
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
    "",
    ...sorted.map((line) => line.text),
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
    ...renderCondition(document),
    ...renderCriteriaSince(document),
    ...renderFeatures(document),
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
