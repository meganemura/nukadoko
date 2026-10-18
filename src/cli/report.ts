import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { createExportsManifest, readExportsManifest, runExportsManifestPath } from "../record/run-exports.js";
import { RUN_RESULT_FILE_NAME, readEndedRuns, readRunResult } from "../record/run-result.js";
import { exportRelativeDir, runRelativeDir } from "../record/state-layout.js";
import { writeAllureResults } from "../report/allure/write-results.js";
import { loadRun, type LoadedRun } from "../report/load-run.js";
import { writeMessagesStream } from "../report/messages/write-stream.js";
import { renderRunSummary } from "../run/run-summary.js";
import { writeOutputLocations } from "../run/progress-log.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { formatEnvelope, refuse, withHint } from "./refusal.js";

// Responsibility: `nuka report`, which renders one finished run directory
// as Markdown, Allure results, or a cucumber-messages stream, after the
// run. A run writes its records and its summary; every other view of it is
// rendered here, from the run directory alone, so a directory copied off a
// CI machine renders the same as one that never moved, and a view can be
// rendered again, in another format, without running anything again.
//
// The alternative refused: emitters that write during the run. They tied
// each report format to a config key, made every worker of a concurrent
// run write its own share, and left a run's export output depending on
// what was switched on before the run, which nobody can change afterward.
//
// Where the output goes: Markdown and messages go to stdout unless `--out`
// names a file; Allure results are a directory, so they go to
// `<stateDir>/export/allure-results` unless `--out` names another. When the
// run directory is one of this project's runs, every file written under
// the state directory is noted in that run's exports manifest, so
// retention removes it with the run, and rendering the same run into the
// same directory again first removes what the last render of it wrote
// there. A report written elsewhere, or of a run from another project, is
// the caller's to keep.

export type ReportFormat = "markdown" | "allure" | "messages";

export interface RunReportOptions {
  rootDir: string;
  /** The run directory as given, or `undefined` for the newest run. */
  runDir: string | undefined;
  format: ReportFormat;
  out: string | undefined;
  json: boolean;
  notices?: readonly Finding[];
  stdout: WritableSink;
  stderr: WritableSink;
}

const REPORT_FILE_DIRS = { allure: "allure-results" } as const;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export async function runReport(options: RunReportOptions): Promise<number> {
  const { rootDir, format, json, stdout, stderr } = options;
  const sinks = { json, stdout, stderr, command: "report" };
  const notices = options.notices ?? [];

  if (json && options.out === undefined && format !== "allure") {
    return refuse(sinks, `nuka report --json needs --out for --format ${format}, since the ${format} output itself would go to stdout`, "invalid-arguments", { fix: `Add --out <path>.` }, notices);
  }

  // The state directory finds the newest run, the default Allure
  // directory, and whether the run is this project's own. A named run
  // directory rendered to `--out` needs none of the three, so a config
  // that does not load stops only the rest.
  let stateDir: string | null = null;
  try {
    stateDir = (await loadConfig(rootDir)).stateDir;
  } catch (error) {
    if (options.runDir === undefined || (format === "allure" && options.out === undefined)) {
      return refuse(sinks, error, "unexpected-error", undefined, notices);
    }
  }

  let runDir: string;
  if (options.runDir !== undefined) {
    runDir = path.resolve(rootDir, options.runDir);
  } else {
    const newest = rankRunsNewestFirst(readEndedRuns(rootDir, stateDir!))[0];
    if (newest === undefined) {
      return refuse(sinks, `no run under ${runRelativeDir(stateDir!, "")} has a run.json`, "run-not-found", { do: "nuka run" }, notices);
    }
    runDir = path.join(rootDir, runRelativeDir(stateDir!, newest.runId));
  }

  const findings: Finding[] = [...notices];
  const outPath = options.out === undefined ? undefined : path.resolve(rootDir, options.out);

  if (format === "markdown") {
    const document = readRunResult(path.join(runDir, RUN_RESULT_FILE_NAME));
    if (document === null) {
      return refuse(sinks, `${runDir} holds no run.json that nuka run wrote`, "run-not-found", undefined, notices);
    }
    const markdown = renderRunSummary(document);
    if (outPath === undefined) {
      for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
      stdout.write(markdown);
      return 0;
    }
    writeFile(outPath, markdown);
    return finish({ runId: document.run_id, written: [outPath], kind: "file" });
  }

  const loaded = loadRun(runDir, rootDir);
  if ("refusal" in loaded) {
    return refuse(sinks, loaded.refusal.message, loaded.refusal.code, undefined, notices);
  }
  const run = loaded.run;
  const ownRun = stateDir !== null && path.resolve(runDir) === path.resolve(rootDir, runRelativeDir(stateDir, run.document.run_id));
  const problems: string[] = [...run.problems];

  if (format === "messages") {
    const lines: string[] = [];
    writeMessagesStream(
      {
        write: (line) => lines.push(line),
        resolvePath: run.resolvePath,
        readFile: (absolutePath) => readFileSync(absolutePath),
        warn: (message) => problems.push(message),
        nukadokoVersion: run.document.nukadoko,
        startedAt: run.document.started_at,
        finishedAt: run.document.finished_at,
        success: run.document.verdict === "passed",
      },
      run.features.map((feature) => ({ ...feature, relativeFeaturePath: feature.relativePath, pickles: selectedPickles(run, feature.relativePath) })),
      run.scenarios.map((scenario) => ({ record: scenario.record, pickle: scenario.pickle, stepRecords: scenario.stepRecords })),
    );
    noteProblems(problems);
    if (outPath === undefined) {
      for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
      stdout.write(lines.join(""));
      return 0;
    }
    replaceOwnFiles(run, ownRun, outPath, "file");
    writeFile(outPath, lines.join(""));
    noteOwnFiles(run, ownRun, [outPath]);
    return finish({ runId: run.document.run_id, written: [outPath], kind: "file" });
  }

  const resultsDir = outPath ?? path.join(rootDir, exportRelativeDir(stateDir!), REPORT_FILE_DIRS.allure);
  replaceOwnFiles(run, ownRun, resultsDir, "dir");
  const written: string[] = [];
  const environments = run.document.environments;
  writeAllureResults(
    {
      resultsDir,
      projectName: run.projectName,
      environment: environments.map((environment) => environment.name).join(", "),
      ...(environments.length === 1 && environments[0]!.target_version !== null ? { targetVersion: environments[0]!.target_version } : {}),
      resolvePath: run.resolvePath,
      onWrite: (absolutePath) => written.push(absolutePath),
      warn: (message) => problems.push(message),
    },
    run.scenarios.map((scenario) => ({
      record: scenario.record,
      stepRecords: scenario.stepRecords,
      gherkinDocument: scenario.feature.gherkinDocument,
      pickle: scenario.pickle,
      relativeFeaturePath: scenario.feature.relativePath,
    })),
  );
  noteProblems(problems);
  noteOwnFiles(run, ownRun, written);
  return finish({ runId: run.document.run_id, written: [resultsDir], kind: "dir", count: run.scenarios.length });

  function noteProblems(messages: readonly string[]): void {
    for (const message of messages) findings.push({ severity: "warning", code: "report-incomplete", message });
  }

  function finish(result: { runId: string; written: readonly string[]; kind: "file" | "dir"; count?: number }): number {
    const relative = result.written.map((written) => path.relative(rootDir, written) || ".");
    if (json) {
      stdout.write(formatEnvelope("report", 0, findings, { run_id: result.runId, format, written: relative }));
      return 0;
    }
    for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
    writeOutputLocations(
      stderr,
      relative.map((relativePath) => ({ label: format, relativePath, kind: result.kind, ...(result.count !== undefined ? { count: result.count } : {}) })),
    );
    return 0;
  }

  // A file this project's run already noted, inside where this render
  // writes, is the previous render of the same run, so it goes before the
  // new one is written instead of piling up beside it.
  function replaceOwnFiles(loadedRun: LoadedRun, own: boolean, target: string, kind: "file" | "dir"): void {
    if (!own || stateDir === null) return;
    for (const relativePath of readExportsManifest(runExportsManifestPath(rootDir, stateDir, loadedRun.document.run_id))) {
      const absolutePath = path.resolve(rootDir, relativePath);
      if (kind === "file" ? absolutePath === target : isInside(target, absolutePath)) rmSync(absolutePath, { force: true });
    }
  }

  function noteOwnFiles(loadedRun: LoadedRun, own: boolean, files: readonly string[]): void {
    if (!own || stateDir === null) return;
    const stateRoot = path.resolve(rootDir, stateDir);
    const manifest = createExportsManifest(runExportsManifestPath(rootDir, stateDir, loadedRun.document.run_id), rootDir);
    for (const file of files) if (isInside(stateRoot, file)) manifest.note(file);
  }
}

/** The pickles of `relativePath` the run selected, in file order: a `:line`
 * run selected fewer than the file holds. */
function selectedPickles(run: LoadedRun, relativePath: string) {
  const selected = new Set(run.scenarios.filter((scenario) => scenario.feature.relativePath === relativePath).map((scenario) => scenario.pickle));
  return run.features.find((feature) => feature.relativePath === relativePath)!.pickles.filter((pickle) => selected.has(pickle));
}

function writeFile(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}
