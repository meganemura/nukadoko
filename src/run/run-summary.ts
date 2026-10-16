import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDir } from "../record/run-exports.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import type { StepRecord } from "../record/types.js";
import {
  collectDeclaredVsObserved,
  renderDeclaredVsObserved,
  type DeclaredVsObserved,
  type DeclaredVsObservedMismatch,
} from "../report/summary/declared-vs-observed.js";
import { hookLabel } from "../report/summary/hook-label.js";
import { readStepRecordsForScenario } from "../report/step-records.js";
import {
  firstErrorLine,
  formatRerunCommand,
  formatStepDuration,
  formatSummaryDuration,
  stepRecordPath,
} from "./progress-log.js";

// Responsibility: the Markdown run summary one `nuka run` invocation leaves
// for a person: in its own run directory always, appended to
// `$GITHUB_STEP_SUMMARY` when that is set, and at `--summary <path>` when
// asked. A reviewer reads two things on a pull request: the `.feature` in
// the diff, and this summary of the run at the pull request's commit. The
// summary therefore says what ran, at which commit, under which condition,
// and how each scenario ended, using only what the run measured.
//
// The collector keeps one small row per scenario record instead of the
// records themselves: a `--repeat` run can write many records, and the
// summary needs a few display values from each. Step records are read once,
// when their scenario record arrives, for the "Declared vs observed" section
// and for the command a failed step ran.
//
// A write failure here is a warning, never a run failure: the exit code is
// the run's verdict, and a summary that could not be written does not
// change what ran.

export const RUN_SUMMARY_FILE_NAME = "summary.md";

/** The first line of every summary, so a CI step can find and update the
 * comment it posted earlier instead of posting another one. */
export const RUN_SUMMARY_MARKER = "<!-- nukadoko:run -->";

export interface SummaryFailure {
  /** `step "<text>"` or a hook's label: where the scenario failed. */
  readonly where: string;
  readonly errorLine: string;
  /** Root-relative step record directory, or the scenario's evidence
   * directory for a hook failure; `null` when nothing was written. */
  readonly recordPath: string | null;
  /** The last command the failed step ran that did not exit 0, as its
   * words joined by spaces. */
  readonly command?: string;
}

export interface SummaryScenario {
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  /** Present when `status` is `"failed"` and the record says why. */
  readonly failure?: SummaryFailure;
}

export interface RunSummaryInput {
  readonly runId: string;
  /** The run's exit verdict, which also counts a BeforeAll or AfterAll
   * failure that no scenario record carries. */
  readonly verdict: "passed" | "failed";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly nukadokoVersion: string;
  readonly environment: string;
  readonly targetVersion: string | undefined;
  readonly git: { readonly commit: string; readonly clean: boolean } | undefined;
  /** Every distinct browser a scenario of the run launched. */
  readonly browsers: readonly { readonly type: string; readonly version: string }[];
  /** One entry per scenario record, in the order the run wrote them. */
  readonly scenarios: readonly SummaryScenario[];
  readonly declaredVsObserved: DeclaredVsObserved;
  /** Flags a rerun line needs to land in the same environment. */
  readonly rerunFlags: readonly string[];
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

function renderTitle(input: RunSummaryInput): string[] {
  const failed = input.scenarios.filter((scenario) => scenario.status === "failed").length;
  const passed = input.scenarios.length - failed;
  const counts = [plural(input.scenarios.length, "scenario"), `${passed} passed`];
  if (failed > 0) counts.push(`${failed} failed`);
  const lines = [`# nukadoko run ${input.verdict}: ${counts.join(", ")}`];
  if (input.verdict === "failed" && failed === 0) {
    lines.push(
      "",
      "No scenario record failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no record, " +
        "failed outside every scenario. The run's stderr names it.",
    );
  }
  return lines;
}

function renderCondition(input: RunSummaryInput): string[] {
  const commit =
    input.git === undefined
      ? "- commit: unknown (no git state was readable when the run started)"
      : `- commit: \`${input.git.commit.slice(0, 7)}\`${input.git.clean ? "" : " with uncommitted changes"}`;
  const environment =
    input.targetVersion === undefined
      ? `- environment: ${input.environment}`
      : `- environment: ${input.environment} (target version ${input.targetVersion})`;
  const browser =
    input.browsers.length === 0
      ? "- browser: none launched"
      : `- browser: ${input.browsers.map((entry) => `${entry.type} ${entry.version}`).join(", ")}`;
  const elapsed = input.finishedAt.getTime() - input.startedAt.getTime();
  return [
    "",
    commit,
    environment,
    browser,
    `- nukadoko: ${input.nukadokoVersion}`,
    `- run: ${input.runId}`,
    `- started ${input.startedAt.toISOString()}, finished ${input.finishedAt.toISOString()} (${formatSummaryDuration(elapsed)})`,
  ];
}

function renderFailureCell(failure: SummaryFailure | undefined): string {
  if (failure === undefined) return "";
  const parts = [`${cellText(failure.where)}: ${cellCode(failure.errorLine)}`];
  if (failure.command !== undefined) parts.push(`ran ${cellCode(failure.command)}`);
  if (failure.recordPath !== null) parts.push(`record ${cellCode(failure.recordPath)}`);
  return parts.join("<br>");
}

// One table per feature file, features by path and scenarios by line, so
// the same run reads the same way at any concurrency. A stable sort keeps
// the executions of one scenario under `--repeat` in the order they ran.
function renderFeatures(scenarios: readonly SummaryScenario[]): string[] {
  const byFeature = new Map<string, SummaryScenario[]>();
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
      lines.push(
        `| ${cellText(row.scenario)} | ${row.line} | ${row.status} | ${formatStepDuration(row.durationMs)} | ${renderFailureCell(row.failure)} |`,
      );
    }
  }
  return lines;
}

function renderRerun(input: RunSummaryInput): string[] {
  const commands = new Set<string>();
  for (const scenario of input.scenarios) {
    if (scenario.status === "failed") commands.add(formatRerunCommand(scenario, input.rerunFlags));
  }
  if (commands.size === 0) return [];
  return ["", "## Rerun a failed scenario", "", "```sh", ...commands, "```"];
}

export function renderRunSummary(input: RunSummaryInput): string {
  const lines = [
    RUN_SUMMARY_MARKER,
    ...renderTitle(input),
    ...renderCondition(input),
    ...renderFeatures(input.scenarios),
    ...renderDeclaredVsObserved(input.declaredVsObserved),
    ...renderRerun(input),
  ];
  return `${lines.join("\n")}\n`;
}

function failedProcess(stepRecord: StepRecord | null | undefined): string | undefined {
  const processes = stepRecord?.observed.processes ?? [];
  for (let index = processes.length - 1; index >= 0; index -= 1) {
    const entry = processes[index]!;
    if (entry.exit_code !== 0) return entry.command.join(" ");
  }
  return undefined;
}

function describeFailure(
  record: ScenarioRecord,
  stepRecords: ReadonlyMap<string, StepRecord | null>,
  stateDir: string,
): SummaryFailure | undefined {
  const step = record.steps.find((entry) => entry.status !== "passed" && entry.status !== "skipped");
  if (step !== undefined) {
    const stepRecord = step.step_record_id === null ? undefined : stepRecords.get(step.step_record_id);
    const command = failedProcess(stepRecord);
    return {
      where: `step "${step.text}"`,
      errorLine: firstErrorLine(step.error?.message ?? ""),
      recordPath: step.step_record_id === null ? null : stepRecordPath(stateDir, step.step_record_id),
      ...(command === undefined ? {} : { command }),
    };
  }
  const hook = record.hooks.find((entry) => entry.status === "failed");
  if (hook !== undefined) {
    return { where: hookLabel(hook), errorLine: firstErrorLine(hook.error?.message ?? ""), recordPath: record.evidence.dir };
  }
  return undefined;
}

export interface RunSummaryCollector {
  /** Called once for each scenario record the run writes. */
  note(record: ScenarioRecord): void;
  /** Everything the records gave; the caller adds what only the run knows. */
  collected(): Pick<RunSummaryInput, "scenarios" | "browsers" | "declaredVsObserved">;
}

export function createRunSummaryCollector(rootDir: string, stateDir: string): RunSummaryCollector {
  const scenarios: SummaryScenario[] = [];
  const browsers = new Map<string, { type: string; version: string }>();
  const mismatches: DeclaredVsObservedMismatch[] = [];
  let compatStepCount = 0;
  return {
    note(record): void {
      const stepRecords = readStepRecordsForScenario(rootDir, record);
      const failure = record.status === "failed" ? describeFailure(record, stepRecords, stateDir) : undefined;
      scenarios.push({
        feature: record.feature,
        line: record.line,
        scenario: record.scenario,
        status: record.status,
        durationMs: Date.parse(record.finished_at) - Date.parse(record.started_at),
        ...(failure === undefined ? {} : { failure }),
      });
      if (record.browser !== undefined) {
        browsers.set(`${record.browser.type}\u0000${record.browser.version}`, record.browser);
      }
      // Only steps that ran have a step record to compare. A step that never
      // began, or whose record cannot be read, has no measurement to set
      // against its declaration.
      const compared = collectDeclaredVsObserved(
        record.steps.flatMap((step) => {
          const stepRecord = step.step_record_id === null ? null : stepRecords.get(step.step_record_id);
          return stepRecord === null || stepRecord === undefined
            ? []
            : [{ scenarioName: record.scenario, stepText: step.text, stepRecord }];
        }),
      );
      mismatches.push(...compared.mismatches);
      compatStepCount += compared.compatStepCount;
    },
    collected() {
      return {
        scenarios,
        browsers: [...browsers.values()],
        declaredVsObserved: { mismatches, compatStepCount },
      };
    },
  };
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
