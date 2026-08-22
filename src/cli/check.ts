import { analyzeProject } from "../check/analyze.js";
import { listCheckCodes } from "../check/codes.js";
import type { CheckIssue } from "../check/types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka check`'s actual work, kept out of run-cli.ts so
// it's unit-testable without going through yargs
// (same split as cli/do.ts, cli/init.ts, cli/scaffold.ts). The report itself
// — human-readable lines or `--json` — is stdout-only; a failure to even
// produce a report (config/discovery error) is stderr + exit 1, the same
// convention every other command already uses via formatVocabularyError.
// Exit code is exactly "1 or more errors" (docs/spec.md "CLI summary":
// warnings alone are exit 0).
//
// `featureArg` is passed straight through to `analyzeProject` unchanged
// (`null`/absent means "no argument", the existing featuresDir-wide
// behavior). `CheckFeatureNotFoundError` needs no
// special handling here — it is an `Error` like every other setup failure
// this catch already turns into stderr + exit 1 via `formatVocabularyError`.
//
// `codes` answers a different question than everything else in this file:
// not "what is wrong with this project" (`analyzeProject`'s own report) but
// "what could `nuka check` ever report" — the catalog src/check/codes.ts
// keeps in sync with the checker at compile time. It short-circuits before
// `analyzeProject` runs at all, on purpose: the catalog holds even for a
// project whose config or discovery is currently broken, which is exactly
// the state a reader reaching for this flag is often in. `featureArg` is
// silently ignored when `codes` is set, the same way `--help` ignores every
// other flag.

export interface RunCheckOptions {
  rootDir: string;
  json: boolean;
  codes?: boolean;
  featureArg?: string;
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
  const { rootDir, json, codes, featureArg, stdout, stderr } = options;

  if (codes) {
    const entries = listCheckCodes();
    if (json) {
      stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      for (const entry of entries) {
        stdout.write(`${formatCodeLine(entry)}\n`);
      }
    }
    return 0;
  }

  let report;
  try {
    report = await analyzeProject(rootDir, featureArg);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const importFailureGroups = groupImportFailuresByMessage(report.errors);
    // Printed at the position of each message's first occurrence in
    // `report.errors` (report order is otherwise untouched) — a message
    // already printed once is skipped on every later occurrence, since its
    // whole file list already went out with the first.
    const printedImportFailureMessages = new Set<string>();
    for (const issue of report.errors) {
      if (issue.code === STEP_FILE_IMPORT_FAILED_CODE) {
        if (printedImportFailureMessages.has(issue.message)) {
          continue;
        }
        printedImportFailureMessages.add(issue.message);
        const files = importFailureGroups.get(issue.message) ?? [];
        stdout.write(`${formatImportFailureGroup(issue.message, files, issue.line)}\n`);
        continue;
      }
      stdout.write(`${formatIssueLine("error", issue)}\n`);
    }
    for (const issue of report.warnings) {
      stdout.write(`${formatIssueLine("warning", issue)}\n`);
    }
    if (report.errors.length === 0 && report.warnings.length === 0) {
      stdout.write("ok: no issues found\n");
    }
  }

  return report.errors.length > 0 ? 1 : 0;
}
