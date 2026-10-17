import { versioned } from "../record/schema-version.js";
import { statSync } from "node:fs";
import path from "node:path";
import { analyzeProject, analyzeRunSelection } from "../check/analyze.js";
import { listCheckCodes } from "../check/codes.js";
import type { CheckIssue, CheckReport } from "../check/types.js";
import { loadConfig } from "../config/load-config.js";
import { describeFailedFeatureRead, type FeatureArgCommand } from "../feature/feature-arg-read.js";
import { resolveOathPaths } from "../feature/resolve-oaths.js";
import { readFeaturesForCheck, resolveFeatureTargets } from "../run/select-pickles.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka check`'s actual work, kept out of run-cli.ts so
// it's unit-testable without going through yargs
// (same split as cli/do.ts, cli/init.ts, cli/scaffold.ts). The report itself
// — human-readable lines or `--json` — is stdout-only; a failure to even
// produce a report (config/discovery error) is stderr + exit 1, the same
// convention every other command already uses via formatVocabularyError.
// Exit code is exactly "1 or more errors" (docs/spec.md "CLI summary":
// warnings alone are exit 0).
//
// `targets` select files the way `nuka run`'s do (src/run/select-pickles.ts:
// files, directories walked for .feature files and configured oaths), so
// the errors `nuka run` prints before executing are this report's errors
// for the same targets. No target keeps the project-wide walk
// (featuresDir, additionalFeatureDirs, every oath), which is wider than a
// bare `nuka run`'s featuresDir. `:line` is refused: check analyzes whole
// files, and a narrowed file would hide findings in its other scenarios.
// A file that does not parse stays a `feature-parse-error` finding here,
// where `nuka run` refuses it, so one broken file does not hide the
// findings in the rest of a directory.
//
// `codes` answers a different question than everything else in this file:
// not "what is wrong with this project" (`analyzeProject`'s own report) but
// "what could `nuka check` ever report" — the catalog src/check/codes.ts
// keeps in sync with the checker at compile time. It short-circuits before
// `analyzeProject` runs at all, on purpose: the catalog holds even for a
// project whose config or discovery is currently broken, which is exactly
// the state a reader reaching for this flag is often in. `targets` are
// silently ignored when `codes` is set, the same way `--help` ignores every
// other flag.

export interface RunCheckOptions {
  rootDir: string;
  json: boolean;
  codes?: boolean;
  /** Feature files, oaths, or directories; empty checks the whole project. */
  targets?: readonly string[];
  stdout: WritableSink;
  stderr: WritableSink;
}

// Shared by formatLocation below and formatImportFailureGroup further
// down: one place decides how a file and an optional line combine into
// the third tab-separated column, so a `step-file-import-failed` finding
// with a `line` prints identically whether or not it went through the
// grouping fold below.
function formatFileAndLine(file: string | undefined, line: number | undefined): string {
  if (file === undefined) {
    return "-";
  }
  return line !== undefined ? `${file}:${line}` : file;
}

function formatLocation(issue: CheckIssue): string {
  if (issue.file !== undefined) {
    return formatFileAndLine(issue.file, issue.line);
  }
  if (issue.step !== undefined) {
    return issue.step;
  }
  return "-";
}

// A message can itself contain newlines (e.g. cucumber-expressions' own
// error messages include a multi-line "^----^" pointer at the offending
// column) — collapsed to single spaces here so the human-readable format's
// "one line per issue" holds even then. `--json` never does this: JSON
// string encoding already handles embedded newlines faithfully, so the raw
// message survives there.
function formatIssueLine(severity: "error" | "warning", issue: CheckIssue): string {
  const singleLineMessage = issue.message.replace(/\s*\n\s*/g, " ");
  return `${severity}\t${issue.code}\t${formatLocation(issue)}\t${singleLineMessage}`;
}

const STEP_FILE_IMPORT_FAILED_CODE = "step-file-import-failed";

// Groups `step-file-import-failed` findings by exact message match, for
// the human-readable rendering only: `CheckIssue`/`analyzeProject`'s own
// `importFailures` are untouched (still one verbatim-message entry per
// file); this is a display-only fold over that same data, never a
// data-structure change, so `--json` below keeps printing `report` exactly
// as `analyzeProject` returned it. Node's own ESM loader caches a module
// that fails to import and rethrows the identical error to every importer,
// so an identical message across files is the one thing this can say for
// certain about them; which file failed *first* is not something the error
// text can answer, so this never singles one out as "the" cause, and only
// ever prints "N files share this message" instead.
// File lists are sorted (dictionary order), not left in report order, so
// the same broken suite renders identically run to run.
function groupImportFailuresByMessage(errors: readonly CheckIssue[]): ReadonlyMap<string, string[]> {
  const byMessage = new Map<string, string[]>();
  for (const issue of errors) {
    if (issue.code !== STEP_FILE_IMPORT_FAILED_CODE) {
      continue;
    }
    const files = byMessage.get(issue.message) ?? [];
    if (issue.file !== undefined) {
      files.push(issue.file);
    }
    byMessage.set(issue.message, files);
  }
  for (const files of byMessage.values()) {
    files.sort((a, b) => a.localeCompare(b));
  }
  return byMessage;
}

// One line for the common case (a single broken file), byte-identical to
// what `formatIssueLine("error", issue)` already printed for it — a
// migrating suite hitting only one broken glue file at a time sees no
// rendering change at all, `line` included (this used to reconstruct the
// file column by hand instead of going through `formatFileAndLine`, which
// silently dropped `line` until it was routed through that function
// instead). A shared-cause group (more than one file
// behind the identical message) instead prints the message once, then the
// sorted file list, one per line, and deliberately never a line number even
// when `line` is passed in: the file whose own path the message's location
// names can itself be one of the group's members (a file that fails to
// transform on its own, imported by a sibling that gets the identical
// rethrown error — tests/check-import-failure-line.test.ts's own
// "shared-project" fixture is exactly that pair), so that member's own
// `CheckIssue.line` is set. But which of the N files that is isn't
// something a reader of the *group* line can tell apart from the others,
// so showing it here would misattribute a within-file position to the
// whole group the same way naming one of them as "the" root cause already
// isn't done above (groupImportFailuresByMessage's own comment) — `line` is
// read only in the `files.length <= 1` branch below, on purpose.
function formatImportFailureGroup(message: string, files: readonly string[], line: number | undefined): string {
  const singleLineMessage = message.replace(/\s*\n\s*/g, " ");
  if (files.length <= 1) {
    return `error\t${STEP_FILE_IMPORT_FAILED_CODE}\t${formatFileAndLine(files[0], line)}\t${singleLineMessage}`;
  }
  const fileLines = files.map((file) => `  ${file}`).join("\n");
  return `error\t${STEP_FILE_IMPORT_FAILED_CODE}\t(${files.length} files)\t${singleLineMessage}\n${fileLines}`;
}

// One line per code, tab-separated (same column style `formatIssueLine`
// already uses for a report line), code then severity then description —
// severity is printed as `-` for a code this registry does not fix to one
// side, rather than left out, so every line has the same column count to
// parse against.
function formatCodeLine(entry: ReturnType<typeof listCheckCodes>[number]): string {
  return `${entry.code}\t${entry.severity ?? "-"}\t${entry.description}`;
}

export async function runCheck(options: RunCheckOptions): Promise<number> {
  const { rootDir, json, codes, stdout, stderr } = options;
  const targets = options.targets ?? [];

  if (codes) {
    const entries = listCheckCodes();
    if (json) {
      stdout.write(`${JSON.stringify(versioned("check_codes", { codes: entries }), null, 2)}\n`);
    } else {
      for (const entry of entries) {
        stdout.write(`${formatCodeLine(entry)}\n`);
      }
    }
    return 0;
  }

  let report;
  try {
    report = targets.length === 0 ? await analyzeProject(rootDir) : await analyzeTargets(rootDir, targets);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  if (json) {
    stdout.write(`${JSON.stringify(versioned("check_report", report), null, 2)}\n`);
  } else {
    writeCheckIssueLines(report.errors, report.warnings, stdout);
    if (report.errors.length === 0 && report.warnings.length === 0) {
      stdout.write("ok: no issues found\n");
    }
  }

  return report.errors.length > 0 ? 1 : 0;
}

async function analyzeTargets(rootDir: string, targets: readonly string[]): Promise<CheckReport> {
  const selected = await readCheckTargets(rootDir, targets);
  return analyzeRunSelection(rootDir, selected.features, selected.parseErrors);
}

/** The feature files `nuka check <targets>` reads, and the ones of them
 * that did not parse. `nuka scaffold --feature` selects its file the same
 * way, so it fills the lines this command would report. */
export async function readCheckTargets(
  rootDir: string,
  targets: readonly string[],
  command: FeatureArgCommand = "nuka check",
): Promise<ReturnType<typeof readFeaturesForCheck>> {
  const config = await loadConfig(rootDir);
  // A target that resolves to nothing is named before any selection, so a
  // `:line` suffix reads as refused rather than as a missing file.
  for (const target of targets) {
    const relativePath = path.relative(rootDir, path.resolve(rootDir, target));
    try {
      statSync(path.join(rootDir, relativePath));
    } catch (error) {
      throw new Error(describeFailedFeatureRead(command, rootDir, relativePath, error).message);
    }
  }
  let selected;
  try {
    const oaths = resolveOathPaths(rootDir, config.oaths);
    const files = resolveFeatureTargets(rootDir, targets, oaths.files, oaths.directories);
    selected = readFeaturesForCheck(rootDir, files.map(([relativePath]) => relativePath));
  } catch (error) {
    throw new Error(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return selected;
}

/**
 * The human-readable report lines, one per finding. `nuka run` writes the
 * errors it refuses over through this same function, so a finding reads
 * the same whichever command found it.
 */
export function writeCheckIssueLines(
  errors: readonly CheckIssue[],
  warnings: readonly CheckIssue[],
  sink: WritableSink,
): void {
  const importFailureGroups = groupImportFailuresByMessage(errors);
  // Printed at the position of each message's first occurrence in
  // `errors` (report order is otherwise untouched). A message already
  // printed once is skipped on every later occurrence, since its whole
  // file list already went out with the first.
  const printedImportFailureMessages = new Set<string>();
  for (const issue of errors) {
    if (issue.code === STEP_FILE_IMPORT_FAILED_CODE) {
      if (printedImportFailureMessages.has(issue.message)) {
        continue;
      }
      printedImportFailureMessages.add(issue.message);
      const files = importFailureGroups.get(issue.message) ?? [];
      sink.write(`${formatImportFailureGroup(issue.message, files, issue.line)}\n`);
      continue;
    }
    sink.write(`${formatIssueLine("error", issue)}\n`);
  }
  for (const issue of warnings) {
    sink.write(`${formatIssueLine("warning", issue)}\n`);
  }
}
