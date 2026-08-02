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

function formatLocation(issue: CheckIssue): string {
  if (issue.file !== undefined) {
    return issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
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
    for (const issue of report.errors) {
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
