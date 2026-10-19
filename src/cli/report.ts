import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { shownTargetPath } from "../feature/feature-arg-read.js";
import { createOutDir, outTargetProblem, type OutKind } from "./report-out.js";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { createExportsManifest, forgetExports, isExportFile, type OwnedExports, readOwnedExports, RUN_EXPORTS_FILE_NAME } from "../record/run-exports.js";
import { readEndedRuns } from "../record/run-result.js";
import { isSymlinkedRunDir } from "../record/contained-path.js";
import { allureResultsRelativeDir, isInsideDir, runRelativeDir, runsRelativeDir } from "../record/state-layout.js";
import { writeAllureResults } from "../report/allure/write-results.js";
import { isOwnRun, loadRun, loadRunDocument, type LoadedRun } from "../report/load-run.js";
import { writeMessagesStream } from "../report/messages/write-stream.js";
import { renderRunSummary } from "../run/run-summary.js";
import { writeOutputLocations } from "../run/progress-log.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { FAILED_EXIT_CODE, formatEnvelope, refuse, withHint } from "./refusal.js";
import type { RefusalCode } from "./refusal-codes.js";

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
// `<stateDir>/export/` is noted in that run's exports manifest, so
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
  // Every path a run names is checked against the run directory's real
  // path, so a symlink under `runs/` would make wherever it points the
  // root those checks trust. A directory named by an explicit path outside
  // `runs/` is the caller's choice, and its real target is the root.
  if (stateDir !== null && isSymlinkedRunDir(rootDir, stateDir, runDir)) {
    return refuse(
      sinks,
      `${path.relative(rootDir, runDir)} is a symlink under ${runsRelativeDir(stateDir)}, so it is not read: a run directory there is one nuka run wrote`,
      "run-invalid",
      { fix: "Copy the run directory in instead of linking it, or name the directory the link points to." },
      notices,
    );
  }

  const findings: Finding[] = [...notices];
  let manifestRefused = false;
  const outPath = options.out === undefined ? undefined : path.resolve(rootDir, options.out);

  // Where the render goes is checked before anything is read, so a target
  // that cannot hold it is refused at once rather than after the render.
  const shown = (absolute: string): string => shownTargetPath(rootDir, path.relative(rootDir, absolute));
  const outKind: OutKind = format === "allure" ? "dir" : "file";
  const outTarget = outPath ?? (format === "allure" ? path.join(rootDir, allureResultsRelativeDir(stateDir!)) : undefined);
  if (outTarget !== undefined) {
    const problem = outTargetProblem(outTarget, outKind, shown);
    if (problem !== null) return refuse(sinks, problem, "report-out-invalid", undefined, notices);
  }

  const output = produce();
  if ("refusal" in output) return refuse(sinks, output.refusal.message, output.refusal.code, undefined, notices);
  if (outTarget !== undefined) {
    const problem = createOutDir(outKind === "dir" ? outTarget : path.dirname(outTarget), shown);
    if (problem !== null) return refuse(sinks, problem, "report-out-invalid", undefined, notices);
  }
  return deliver(output);

  // Each format only produces its output: one text, or a directory of
  // files and the function that writes them. Where it goes, what the
  // manifest notes, and the exit code are one tail for all three
  // (`deliver`), so a format cannot skip a step the others take.
  function produce(): ReportOutput | { refusal: { code: RefusalCode; message: string } } {
    if (format === "markdown") {
      const read = loadRunDocument(runDir);
      if ("refusal" in read) return read;
      return { kind: "text", runId: read.document.run_id, ownRun: isOwnRun(runDir, rootDir, stateDir, read.document.run_id), text: renderRunSummary(read.document), problems: [] };
    }
    const loaded = loadRun(runDir, rootDir, stateDir);
    if ("refusal" in loaded) return loaded;
    const run = loaded.run;
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
      return { kind: "text", runId: run.document.run_id, ownRun: run.ownRun, text: lines.join(""), problems };
    }
    const environments = run.document.environments;
    return {
      kind: "dir",
      runId: run.document.run_id,
      ownRun: run.ownRun,
      dir: outPath ?? path.join(rootDir, allureResultsRelativeDir(stateDir!)),
      problems,
      write: (resultsDir, onWrite) =>
        writeAllureResults(
          {
            resultsDir,
            projectName: run.projectName,
            environment: environments.map((environment) => environment.name).join(", "),
            ...(environments.length === 1 && environments[0]!.target_version !== null ? { targetVersion: environments[0]!.target_version } : {}),
            resolvePath: run.resolvePath,
            onWrite,
            warn: (message) => problems.push(message),
          },
          run.scenarios.map((scenario) => ({
            record: scenario.record,
            stepRecords: scenario.stepRecords,
            gherkinDocument: scenario.feature.gherkinDocument,
            pickle: scenario.pickle,
            relativeFeaturePath: scenario.feature.relativePath,
          })),
        ),
    };
  }

  function deliver(output: ReportOutput): number {
    if (output.kind === "text" && outPath === undefined) {
      noteProblems(output.problems);
      const exitCode = output.problems.length > 0 ? FAILED_EXIT_CODE : 0;
      for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
      stdout.write(output.text);
      return exitCode;
    }
    const target = output.kind === "text" ? outPath! : output.dir;
    replaceOwnFiles(output, target, output.kind === "text" ? "file" : "dir");
    const written: string[] = [];
    if (output.kind === "text") {
      writeFile(target, output.text);
      written.push(target);
    } else {
      output.write(target, (absolutePath) => written.push(absolutePath));
    }
    noteOwnFiles(output, written);
    noteProblems(output.problems);
    const exitCode = findings.some((finding) => finding.code === "report-incomplete") ? FAILED_EXIT_CODE : 0;
    const relative = path.relative(rootDir, target) || ".";
    if (json) {
      stdout.write(formatEnvelope("report", exitCode, findings, { run_id: output.runId, format, written: [relative] }));
      return exitCode;
    }
    for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
    // A directory's count is the results that landed in it, not the
    // scenarios the run holds: a scenario whose result failed to write is
    // a problem above, and counting it here would say otherwise.
    const count = output.kind === "dir" ? written.filter((file) => file.endsWith("-result.json")).length : undefined;
    writeOutputLocations(stderr, [{ label: format, relativePath: relative, kind: output.kind === "dir" ? "dir" : "file", ...(count !== undefined ? { count } : {}) }]);
    return exitCode;
  }

  // A report that left part of the run out is red: a script that publishes
  // it must not take it for the whole run.
  function noteProblems(messages: readonly string[]): void {
    for (const message of messages) findings.push({ severity: "failed", code: "report-incomplete", message });
  }

  // A file this project's run already noted, inside where this render
  // writes, is the previous render of the same run, so it goes before the
  // new one is written instead of piling up beside it.
  function replaceOwnFiles(output: ReportOutput, target: string, kind: "file" | "dir"): void {
    const owned = ownExports(output);
    if (owned === null || owned.manifestPath === null) return;
    const replaced = new Set<string>();
    for (const { line, absolutePath } of owned.files) {
      if (kind === "file" ? absolutePath === target : isInsideDir(target, absolutePath)) {
        rmSync(absolutePath, { force: true });
        replaced.add(line);
      }
    }
    if (replaced.size > 0) forgetExports(owned.manifestPath, replaced);
  }

  // What this project's own run's exports manifest names, or `null` for a
  // run that is not this project's. A manifest that is a symlink out of
  // the run directory is refused (`manifestPath` `null`): following it
  // would read or append to a file elsewhere.
  function ownExports(output: ReportOutput): OwnedExports | null {
    if (!output.ownRun || stateDir === null) return null;
    const owned = readOwnedExports(rootDir, stateDir, output.runId);
    if (owned.manifestPath === null && !manifestRefused) {
      noteProblems([`${RUN_EXPORTS_FILE_NAME} of run ${output.runId} resolves outside the run directory, so this render is not noted in it`]);
      manifestRefused = true;
    }
    return owned;
  }

  function noteOwnFiles(output: ReportOutput, files: readonly string[]): void {
    const owned = ownExports(output);
    if (owned === null || owned.manifestPath === null || stateDir === null) return;
    const manifest = createExportsManifest(owned.manifestPath, rootDir);
    for (const file of files) if (isExportFile(rootDir, stateDir, file)) manifest.note(file);
  }
}

/** What one format produced, before the shared tail writes it. */
type ReportOutput =
  | { readonly kind: "text"; readonly runId: string; readonly ownRun: boolean; readonly text: string; readonly problems: readonly string[] }
  | {
      readonly kind: "dir";
      readonly runId: string;
      readonly ownRun: boolean;
      readonly dir: string;
      /** Filled while `write` runs. */
      readonly problems: readonly string[];
      readonly write: (dir: string, onWrite: (absolutePath: string) => void) => void;
    };

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
