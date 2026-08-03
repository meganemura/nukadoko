import { analyzeTend } from "../tend/analyze.js";
import type { TendIssue } from "../tend/types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka tend`'s actual work, kept out of run-cli.ts the same
// way cli/check.ts's own `runCheck` is (unit-testable without going through
// yargs). Exit code is "1 or more errors" (docs/spec.md "Tending": "the
// sign-off finding exits non-zero … the rest do not, because a project is
// allowed to carry them") — in m8a `errors` is always `[]`, so this always
// exits 0 until m8b adds the one finding that can set it to 1.
//
// `formatLocation`/`formatIssueLine` are a small, deliberate duplicate of
// cli/check.ts's own private (unexported) helpers of the same name, not an
// import from that file: cli/check.ts is outside this task's file
// ownership, and the two commands' human-readable formats only coincide by
// convention (this task's spec: "nuka check の text 出力の作りに倣う") —
// sharing the implementation would wire the two commands' output format
// together for no reason either command needs.

export interface RunTendOptions {
  rootDir: string;
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

function formatLocation(issue: TendIssue): string {
  if (issue.file !== undefined) {
    return issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  }
  if (issue.step !== undefined) {
    return issue.step;
  }
  return "-";
}

// Same newline-collapsing as cli/check.ts's own `formatIssueLine` — a
// message can carry embedded newlines (e.g. a from-unused message quoting
// another tool's own multi-line output), and text output's "one line per
// issue" only holds if those are flattened; `--json` never does this, JSON
// string encoding already carries a raw newline faithfully.
function formatIssueLine(severity: "error" | "note", issue: TendIssue): string {
  const singleLineMessage = issue.message.replace(/\s*\n\s*/g, " ");
  return `${severity}\t${issue.code}\t${formatLocation(issue)}\t${singleLineMessage}`;
}

export async function runTend(options: RunTendOptions): Promise<number> {
  const { rootDir, json, stdout, stderr } = options;

  let report;
  try {
    report = await analyzeTend(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // Grouped by kind (this task's spec): errors first (always empty until
    // m8b), then notes — and `analyzeTend` already builds `notes` as five
    // consecutive per-finding blocks, so printing it in order is grouping,
    // with no sort needed here.
    for (const issue of report.errors) {
      stdout.write(`${formatIssueLine("error", issue)}\n`);
    }
    for (const issue of report.notes) {
      stdout.write(`${formatIssueLine("note", issue)}\n`);
    }
    if (report.errors.length === 0 && report.notes.length === 0) {
      stdout.write("ok: nothing to tend\n");
    }
  }

  return report.errors.length > 0 ? 1 : 0;
}
