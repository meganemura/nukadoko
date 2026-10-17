import { versioned } from "../record/schema-version.js";
import { analyzeTend } from "../tend/analyze.js";
import {
  listTendCodes,
  REMOVED_TEND_CODES,
  selectReportedNotes,
  TEND_CODES,
  type TendIssue,
  type TendSummary,
} from "../tend/types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka tend`'s actual work, kept out of run-cli.ts the same
// way cli/check.ts's own `runCheck` is (unit-testable without going through
// yargs). Exit code is "1 or more errors, or a `--fail-on` code that
// fired". Every finding this command reports today is a note (docs/spec.md
// "Tending": a project is allowed to carry them), so `--fail-on` is the one
// way a run of `nuka tend` turns red.
//
// `formatLocation`/`formatIssueLine` are a small, deliberate duplicate of
// cli/check.ts's own private (unexported) helpers of the same name, not an
// import from that file: the two commands' human-readable formats only
// coincide by convention, matching `nuka check`'s text output so the two
// look consistent — sharing the implementation would wire the two
// commands' output format together for no reason either command needs.
//
// `formatSummaryLines` prints ahead of every finding, in plain
// "label: value" prose rather than the tab-separated `error`/`note` line
// shape below — deliberately, so a reader can tell "this is where the bed
// is" from "this is a finding" without reading either line's content
// (docs/spec.md "Tending": the summary is not itself a finding). It always
// prints, even with zero compat steps or an otherwise empty report —
// "typed 12, compat 0" is itself the useful fact that migration is done.
//
// The `scanned:` line prints first, ahead of `bed:` — a reader needs to
// know what was looked at before a count derived from that look means
// anything; this is the fact that makes `pattern-unbound` legible instead
// of quietly wrong the moment a feature lives outside `featuresDir`. `read-only` joins the `bed:` line itself rather than a
// fourth line, since it is counted in the exact same vocabulary walk as
// `typed`/`compat` (src/tend/summary.ts).
//
// The two declaration codes (src/tend/note-selection.ts) are left out of
// both text and `--json` unless `--all` is given or `--fail-on` names one.
// The `declared:` line still counts them, and says `--all` names each one
// when any was left out, so the gap stays visible without a note per step.

export interface RunTendOptions {
  rootDir: string;
  json: boolean;
  /** `--codes`: print the code catalog instead of tending a project. It
   * answers before the project loads, so it works while config is broken. */
  codes?: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
  /** `--fail-on`: codes whose presence turns this invocation's exit code
   * red. Empty by default, so a note stays a note (docs/spec.md "Tending"). */
  failOn: readonly string[];
  /** `--all`: also report the declaration notes (missing `rationale`,
   * missing `.describe()`), which are left out by default. */
  all: boolean;
}

function formatLocation(issue: TendIssue): string {
  if (issue.file !== undefined) {
    return issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  }
  if (issue.step !== undefined) {
    return issue.step;
  }
  if (issue.fixture !== undefined) {
    return issue.fixture;
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

// Two lines, matching docs/spec.md's own CLI summary phrasing for `nuka
// tend` ("how much of the vocabulary is typed rather than compat and how
// much of it declares what it could"). `compat_step_names` is left out of
// text on purpose: text output is what a human takes in at a glance, so it
// stays as counts; it is still on `report.summary` for `--json`, which
// dumps the whole report as-is below, because naming the actual steps is
// more useful than a count to whatever reads that machine-readable form.
function formatSummaryLines(summary: TendSummary, declarationNotesLeftOut: boolean): string[] {
  const declared =
    `declared: rationale ${summary.rationale.declared}/${summary.rationale.total}, ` +
    `describe ${summary.describe.declared}/${summary.describe.total}`;
  return [
    `scanned: ${summary.scanned_feature_dirs.join(", ")}`,
    `bed: typed ${summary.typed_steps}, compat ${summary.compat_steps}, read-only ${summary.read_only_steps}`,
    declarationNotesLeftOut ? `${declared} (nuka tend --all names each one)` : declared,
  ];
}

export async function runTend(options: RunTendOptions): Promise<number> {
  const { rootDir, json, failOn, all, stdout, stderr } = options;

  if (options.codes) {
    const entries = listTendCodes();
    if (json) {
      stdout.write(`${JSON.stringify(versioned("tend_codes", { codes: entries }), null, 2)}\n`);
    } else {
      for (const entry of entries) {
        stdout.write(`${entry.code}\t${entry.reportedByDefault ? "default" : "--all"}\t${entry.description}\n`);
      }
    }
    return 0;
  }

  // Refused before anything is analyzed: a code tend never emits would
  // otherwise be a flag that never fires, and a team gating a PR on it
  // would read that silence as "nothing to fail on".
  // A removed code is refused too, but by name and with what replaced it,
  // so a CI job written against an earlier release learns where to go.
  const removed = failOn.filter((code) => REMOVED_TEND_CODES.has(code));
  if (removed.length > 0) {
    for (const code of removed) {
      stderr.write(`--fail-on: "${code}" ${REMOVED_TEND_CODES.get(code)}.\n`);
    }
    return 1;
  }
  const unknown = failOn.filter((code) => !TEND_CODES.has(code));
  if (unknown.length > 0) {
    stderr.write(
      `--fail-on: ${unknown.map((code) => `"${code}"`).join(", ")} ${unknown.length === 1 ? "is not a code" : "are not codes"} ` +
        `nuka tend reports. The codes are: ${[...TEND_CODES].sort().join(", ")}.\n`,
    );
    return 1;
  }

  let analyzed;
  try {
    analyzed = await analyzeTend(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }
  const notes = selectReportedNotes(analyzed.notes, { all, failOn });
  const report = { ...analyzed, notes };

  if (json) {
    stdout.write(`${JSON.stringify(versioned("tend_report", report), null, 2)}\n`);
  } else {
    // Summary first, ahead of the findings, then the findings grouped by
    // kind: errors first (always empty today, src/tend/analyze.ts's
    // header), then notes — and `analyzeTend` already builds `notes` as consecutive
    // per-finding blocks, so printing it in order is grouping, with no sort
    // needed here.
    for (const line of formatSummaryLines(report.summary, notes.length < analyzed.notes.length)) {
      stdout.write(`${line}\n`);
    }
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

  // `--fail-on` turns a chosen note into a red exit for this invocation
  // only; the finding itself stays a note in the output, since what
  // changed is the team's policy, not the finding's nature. Said on
  // stderr, once per code, so the exit code never changes silently.
  let failed = false;
  for (const code of failOn) {
    const count = [...report.errors, ...report.notes].filter((issue) => issue.code === code).length;
    if (count > 0) {
      failed = true;
      stderr.write(`fail-on: ${code} reported ${count} ${count === 1 ? "finding" : "findings"}\n`);
    }
  }
  return report.errors.length > 0 || failed ? 1 : 0;
}
