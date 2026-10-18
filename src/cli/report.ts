import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { createExportsManifest, forgetExports, readExportsManifest, runExportsManifestPath } from "../record/run-exports.js";
import { readEndedRuns } from "../record/run-result.js";
import { allureResultsRelativeDir, runRelativeDir } from "../record/state-layout.js";
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

  const output = produce();
  if ("refusal" in output) return refuse(sinks, output.refusal.message, output.refusal.code, undefined, notices);
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
    const exitCode = output.problems.length > 0 ? FAILED_EXIT_CODE : 0;
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
    if (!output.ownRun || stateDir === null) return;
    const manifestPath = runExportsManifestPath(rootDir, stateDir, output.runId);
    const replaced = new Set<string>();
    for (const relativePath of readExportsManifest(manifestPath)) {
      const absolutePath = path.resolve(rootDir, relativePath);
      if (kind === "file" ? absolutePath === target : isInside(target, absolutePath)) {
        rmSync(absolutePath, { force: true });
        replaced.add(relativePath);
      }
    }
    if (replaced.size > 0) forgetExports(manifestPath, replaced);
  }

  function noteOwnFiles(output: ReportOutput, files: readonly string[]): void {
    if (!output.ownRun || stateDir === null) return;
    const stateRoot = path.resolve(rootDir, stateDir);
    const manifest = createExportsManifest(runExportsManifestPath(rootDir, stateDir, output.runId), rootDir);
    for (const file of files) if (isInside(stateRoot, file)) manifest.note(file);
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
