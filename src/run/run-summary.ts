import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { whereOf, type Finding } from "../finding/finding.js";
import { runDir } from "../record/run-exports.js";
import type { RunDocument, RunScenario } from "../record/run-result.js";
import {
  collectDeclaredVsObserved,
  renderDeclaredVsObserved,
  type ComparedStep,
} from "../report/summary/declared-vs-observed.js";
import { hookLabel } from "../report/summary/hook-label.js";
import {
  exitedProducers,
  firstErrorLine,
  formatStepDuration,
  formatSummaryDuration,
  type ExitedProducer,
} from "./progress-log.js";

// Responsibility: the Markdown run summary one `nuka run` invocation leaves
// for a person: in its own run directory always, appended to
// `$GITHUB_STEP_SUMMARY` when that is set, and at `--summary <path>` when
// asked. It says what ran, at which commit, under which condition, and how
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

// Text a reader sees in a table cell. A `|` would end the cell, and `<`
// could open an HTML tag in GitHub's renderer.
function cellText(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

// A code span longer than any backtick run inside it, so an error message
// that quotes code cannot close it early. In a table, `|` still needs its
// backslash inside a code span.
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

function renderTitle(document: RunDocument): string[] {
  const failed = document.scenarios.filter((scenario) => scenario.status === "failed").length;
  const passed = document.scenarios.length - failed;
  const counts = [plural(document.scenarios.length, "scenario"), `${passed} passed`];
  if (failed > 0) counts.push(`${failed} failed`);
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
  const environment =
    document.target_version === null
      ? `- environment: ${document.environment}`
      : `- environment: ${document.environment} (target version ${document.target_version})`;
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
    environment,
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
    parts.push(`used ${cellText(producer.step)} exit ${producer.exitCode}: ${cellCode(producer.stderrLine)}`);
  }
  if (failure.command !== undefined) parts.push(`ran ${cellCode(failure.command)}`);
  if (failure.recordPath !== null) parts.push(`record ${cellCode(failure.recordPath)}`);
  return parts.join("<br>");
}

function durationOf(scenario: RunScenario): number {
  return Date.parse(scenario.finished_at) - Date.parse(scenario.started_at);
}

// One table per feature file, features by path and scenarios by line, so
// the same run reads the same way at any concurrency. A stable sort keeps
// the executions of one scenario under `--repeat` in the order they ran.
function renderFeatures(scenarios: readonly RunScenario[]): string[] {
  const byFeature = new Map<string, RunScenario[]>();
  for (const scenario of scenarios) {
    const rows = byFeature.get(scenario.feature) ?? [];
    rows.push(scenario);
    byFeature.set(scenario.feature, rows);
  }
  const lines: string[] = [];
  for (const feature of [...byFeature.keys()].sort()) {
    const rows = [...byFeature.get(feature)!].sort((a, b) => a.line - b.line);
    lines.push(
      "",
      `## ${cellText(feature)}`,
      "",
      "| scenario | line | status | duration | failure |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const row of rows) {
      const failure = row.status === "failed" ? describeFailure(row) : undefined;
      lines.push(
        `| ${cellText(row.scenario)} | ${row.line} | ${row.status} | ${formatStepDuration(durationOf(row))} | ${renderFailureCell(failure)} |`,
      );
    }
  }
  return lines;
}

// Only steps with a step record carry a declaration and a measurement. A
// step that never began has nothing to set against its declaration.
function comparedSteps(scenarios: readonly RunScenario[]): ComparedStep[] {
  return scenarios.flatMap((scenario) =>
    scenario.steps.flatMap((step) =>
      step.mutates === undefined || step.observed === undefined
        ? []
        : [{ scenarioName: scenario.scenario, stepText: step.text, stepRecord: { mutates: step.mutates, observed: step.observed } }],
    ),
  );
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
    ...renderFeatures(document.scenarios),
    ...renderDeclaredVsObserved(collectDeclaredVsObserved(comparedSteps(document.scenarios))),
    ...renderFindings(document),
    ...renderRerun(document),
  ];
  return `${lines.join("\n")}\n`;
}

export interface RunSummaryTargets {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly runId: string;
  /** `--summary <path>`, resolved against `rootDir`; replaced, not
   * appended, because it is this run's file. */
  readonly summaryPath: string | undefined;
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
  if (targets.summaryPath !== undefined) {
    const destination = path.resolve(targets.rootDir, targets.summaryPath);
    attempt(targets.summaryPath, () => {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, markdown);
    });
  }
  if (targets.stepSummaryPath !== undefined) {
    const destination = targets.stepSummaryPath;
    attempt("GITHUB_STEP_SUMMARY", () => appendFileSync(destination, markdown));
  }
  return { runSummaryPath: wroteRunCopy ? path.relative(targets.rootDir, runCopy) : null, warnings };
}
