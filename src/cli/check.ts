import { statSync } from "node:fs";
import path from "node:path";
import { analyzeProject, analyzeRunSelection } from "../check/analyze.js";
import { listCheckCodes } from "../check/codes.js";
import type { CheckFinding, CheckIssue, CheckReport } from "../check/types.js";
import { loadConfig } from "../config/load-config.js";
import { describeFailedFeatureRead, type FeatureArgCommand } from "../feature/feature-arg-read.js";
import { resolveOathPaths } from "../feature/resolve-oaths.js";
import { readFeaturesForCheck, resolveFeatureTargets } from "../run/select-pickles.js";
import { listRunCodes } from "../finding/run-codes.js";
import { shellWord } from "../shell/shell-word.js";
import {
  type Finding,
  type FindingText,
  type Severity,
  formatFinding,
  formatFindingText,
  toText,
  whereOf,
} from "../finding/finding.js";
import { listRefusalCodes } from "./refusal-codes.js";
import { RefusalError, formatEnvelope, refuse, restated } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka check`'s actual work, kept out of run-cli.ts so
// it's unit-testable without going through yargs
// (same split as cli/do.ts, cli/init.ts, cli/scaffold.ts). The report itself
// — human-readable lines or `--json` — is stdout-only; a failure to even
// produce a report (config/discovery error) is a refusal (cli/refusal.ts):
// `{ error, do }` on stdout under `--json`, the message and a `do:` line on
// stderr otherwise.
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
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  notices?: readonly Finding[];
  stdout: WritableSink;
  stderr: WritableSink;
}

// The codes whose identical messages fold into one group: a step file that
// did not import, and one that did not import because a Playwright package
// is missing (one message for every such file, so one install line).
const FOLDED_CODES: ReadonlySet<string> = new Set(["step-file-import-failed", "playwright-missing"]);

function foldKey(issue: { readonly code: string; readonly message: string }): string {
  return `${issue.code}\u0000${issue.message}`;
}

// Groups the import-failure findings by exact message, for the text form
// only: `--json` keeps one finding per file. Node's ESM loader caches a
// module that fails to import and rethrows the identical error to every
// importer, so an identical message across files is the one thing this can
// say for certain about them; which file failed first is not, so the group
// names no file as the cause. File lists are sorted so the same broken
// suite prints the same text on every run.
function groupImportFailuresByMessage(errors: readonly CheckIssue[]): ReadonlyMap<string, string[]> {
  const byMessage = new Map<string, string[]>();
  for (const issue of errors) {
    if (!FOLDED_CODES.has(issue.code)) {
      continue;
    }
    const files = byMessage.get(foldKey(issue)) ?? [];
    if (issue.file !== undefined) {
      files.push(issue.file);
    }
    byMessage.set(foldKey(issue), files);
  }
  for (const files of byMessage.values()) {
    files.sort((a, b) => a.localeCompare(b));
  }
  return byMessage;
}

// One file prints the finding as it is, `line` included. A group of files
// prints the message once, `(N files)` in the location column, and the
// sorted list under it, and never a line: the line belongs to one member,
// and a reader of the group line cannot tell which.
function importFailureGroupText(issue: CheckFinding, files: readonly string[]): FindingText {
  const one = toText(asFinding("error", issue));
  if (files.length <= 1) return { ...one, where: whereOf({ ...issue, ...(files[0] !== undefined ? { file: files[0] } : {}) }) };
  return { ...one, where: `(${files.length} files)`, paths: files };
}

/** A check finding as the envelope and the text lines carry it. */
export function asFinding(severity: "error" | "warning", issue: CheckFinding): Finding {
  return { severity, ...issue };
}

/** The findings of a report, errors first, in report order. */
export function reportFindings(report: CheckReport): Finding[] {
  return [
    ...report.errors.map((issue) => asFinding("error", issue)),
    ...report.warnings.map((issue) => asFinding("warning", issue)),
  ];
}

/** One finding per code, in the finding grammar: the code's severity, the
 * code, `-` for the location, its description, and its general fix. One
 * parser reads `--codes` and a report alike. */
export function codeFinding(entry: { code: string; severity: Severity; description: string; fix: string }): Finding {
  return { severity: entry.severity, code: entry.code, message: entry.description, fix: entry.fix };
}

/** Every code `nuka check` and `nuka run` can print: check findings, run
 * findings, and refusals, each with its severity. */
export function listAllCheckCodes(): Finding[] {
  const entries = [
    ...listCheckCodes(),
    ...listRunCodes(),
    ...listRefusalCodes().map((entry) => ({ ...entry, severity: entry.severity ?? ("refused" as const) })),
  ];
  return entries.sort((a, b) => a.code.localeCompare(b.code)).map(codeFinding);
}

export async function runCheck(options: RunCheckOptions): Promise<number> {
  const { rootDir, json, codes, stdout, stderr } = options;
  const targets = options.targets ?? [];
  const notices = options.notices ?? [];
  const sinks = { json, stdout, stderr, command: "check" };

  if (codes) {
    const entries = listAllCheckCodes();
    if (json) {
      stdout.write(formatEnvelope("check", 0, notices, { codes: entries }));
    } else {
      for (const entry of entries) stdout.write(formatFinding(entry));
    }
    return 0;
  }

  let report;
  try {
    report = targets.length === 0 ? await analyzeProject(rootDir) : await analyzeTargets(rootDir, targets);
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }

  const exitCode = report.errors.length > 0 ? 1 : 0;
  if (json) {
    stdout.write(formatEnvelope("check", exitCode, [...notices, ...reportFindings(report)]));
  } else {
    writeCheckIssueLines(report.errors, report.warnings, stdout);
    if (report.errors.length === 0 && report.warnings.length === 0) {
      stdout.write("ok: no issues found\n");
    }
  }
  return exitCode;
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
      const read = describeFailedFeatureRead(command, rootDir, relativePath, error);
      throw new RefusalError(
        read.kind === "line" ? "line-not-supported" : read.kind === "not-found" ? "target-not-found" : "target-unreadable",
        read.message,
        read.basePath === undefined ? {} : { do: `${command} ${shellWord(read.basePath)}` },
      );
    }
  }
  let selected;
  try {
    const oaths = resolveOathPaths(rootDir, config.oaths);
    const files = resolveFeatureTargets(rootDir, targets, oaths.files, oaths.directories);
    selected = readFeaturesForCheck(rootDir, files.map(([relativePath]) => relativePath));
  } catch (error) {
    const message = `${command}: ${error instanceof Error ? error.message : String(error)}`;
    throw restated(error, message, "unexpected-error", command.replace(/^nuka /, ""));
  }
  return selected;
}

/**
 * The human-readable report lines, one per finding. `nuka run` writes the
 * errors it refuses over through this same function, so a finding reads
 * the same whichever command found it.
 */
export function writeCheckIssueLines(
  errors: readonly CheckFinding[],
  warnings: readonly CheckFinding[],
  sink: WritableSink,
): void {
  const importFailureGroups = groupImportFailuresByMessage(errors);
  // Printed at the position of each message's first occurrence in
  // `errors` (report order is otherwise untouched). A message already
  // printed once is skipped on every later occurrence, since its whole
  // file list already went out with the first.
  const printedImportFailureMessages = new Set<string>();
  for (const issue of errors) {
    if (FOLDED_CODES.has(issue.code)) {
      if (printedImportFailureMessages.has(foldKey(issue))) {
        continue;
      }
      printedImportFailureMessages.add(foldKey(issue));
      const files = importFailureGroups.get(foldKey(issue)) ?? [];
      sink.write(formatFindingText(importFailureGroupText(issue, files)));
      continue;
    }
    sink.write(formatFinding(asFinding("error", issue)));
  }
  for (const issue of warnings) {
    sink.write(formatFinding(asFinding("warning", issue)));
  }
}
