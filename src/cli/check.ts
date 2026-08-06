import { analyzeProject } from "../check/analyze.js";
import type { CheckIssue } from "../check/types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka check`'s actual work (this task's spec, item 6),
// kept out of run-cli.ts so it's unit-testable without going through yargs
// (same split as cli/do.ts, cli/init.ts, cli/scaffold.ts). The report itself
// — human-readable lines or `--json` — is stdout-only; a failure to even
// produce a report (config/discovery error) is stderr + exit 1, the same
// convention every other command already uses via formatVocabularyError.
// Exit code is exactly "1 or more errors" (docs/spec.md "CLI summary":
// warnings alone are exit 0).
//
// m5b-check-feature-arg task spec: `featureArg` is passed straight through
// to `analyzeProject` unchanged (`null`/absent means "no argument", the
// existing featuresDir-wide behavior). `CheckFeatureNotFoundError` needs no
// special handling here — it is an `Error` like every other setup failure
// this catch already turns into stderr + exit 1 via `formatVocabularyError`.

export interface RunCheckOptions {
  rootDir: string;
  json: boolean;
  featureArg?: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

// Shared by formatLocation below and formatImportFailureGroup further down
// (fb5-import-error-line task spec, item 3: "そこに乗るだけで、新しい出力
// 形式を作らないこと") — one place decides how a file and an optional line
// combine into the third tab-separated column, so a `step-file-import-
// failed` finding with a `line` prints identically whether or not it went
// through the grouping fold below.
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

// Groups `step-file-import-failed` findings by exact message match, for the
// human-readable rendering only (fb5-loader-visibility task spec, decision
// 3) — `CheckIssue`/`analyzeProject`'s own `importFailures` are untouched
// (still one verbatim-message entry per file); this is a display-only fold
// over that same data, never a data-structure change, so `--json` below
// keeps printing `report` exactly as `analyzeProject` returned it. Node's
// own ESM loader caches a module that fails to import and rethrows the
// identical error to every importer, so an identical message across files
// is the one thing this can say for certain about them; which file failed
// *first* is not something the error text can answer, so this never singles
// one out as "the" cause (this task's spec: "root cause のファイルを断定し
// てはいけない" — only "N files share this message" is ever printed).
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
// rendering change at all, `line` included (fb5-import-error-line task
// spec, item 3 — this used to reconstruct the file column by hand instead
// of going through `formatFileAndLine`, which silently dropped `line`
// before that task added it). A shared-cause group (more than one file
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

export async function runCheck(options: RunCheckOptions): Promise<number> {
  const { rootDir, json, featureArg, stdout, stderr } = options;

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
