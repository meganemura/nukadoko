import { analyzeTend } from "../tend/analyze.js";
import {
  listTendCodes,
  REMOVED_TEND_CODES,
  TEND_CODES,
  type TendFinding,
  type TendSummary,
} from "../tend/types.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { codeFinding } from "./check.js";
import { formatEnvelope, refuse } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka tend`'s actual work, kept out of run-cli.ts the same
// way cli/check.ts's own `runCheck` is (unit-testable without going through
// yargs). Exit code is "1 or more errors, or a `--fail-on` code that
// fired". Every finding this command reports today is a note (docs/spec.md
// "Tending": a project is allowed to carry them), so `--fail-on` is the one
// way a run of `nuka tend` turns red.
//
// Findings print in the grammar src/finding/finding.ts owns, the one
// every command shares, so a reader parses check and tend alike.
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
// Every code is reported. A default-off code once kept the declaration
// note out of plain runs, and a CI gate that parsed plain `--json` passed
// without ever seeing it; `--fail-on` is the way to choose what gates.

export interface RunTendOptions {
  rootDir: string;
  json: boolean;
  /** `--codes`: print the code catalog instead of tending a project. It
   * answers before the project loads, so it works while config is broken. */
  codes?: boolean;
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  notices?: readonly Finding[];
  stdout: WritableSink;
  stderr: WritableSink;
  /** `--fail-on`: codes whose presence turns this invocation's exit code
   * red. Empty by default, so a note stays a note (docs/spec.md "Tending"). */
  failOn: readonly string[];
}

/** A tend finding in the shared grammar. A finding about a config.fixtures
 * entry names the fixture where a step finding names the step. */
function tendFinding(severity: "error" | "note", issue: TendFinding): Finding {
  return { severity, ...issue, ...(issue.step === undefined && issue.fixture !== undefined ? { step: issue.fixture } : {}) };
}

function asJsonFinding(severity: "error" | "note", issue: TendFinding): Finding {
  return { severity, ...issue };
}

// Two lines, matching docs/spec.md's own CLI summary phrasing for `nuka
// tend` ("how much of the vocabulary is typed rather than compat and how
// much of it declares what it could"). `compat_step_names` is left out of
// text on purpose: text output is what a human takes in at a glance, so it
// stays as counts; it is still on `report.summary` for `--json`, which
// dumps the whole report as-is below, because naming the actual steps is
// more useful than a count to whatever reads that machine-readable form.
function formatSummaryLines(summary: TendSummary): string[] {
  return [
    `scanned: ${summary.scanned_feature_dirs.join(", ")}`,
    `bed: typed ${summary.typed_steps}, compat ${summary.compat_steps}, read-only ${summary.read_only_steps}`,
    `declared: describe ${summary.describe.declared}/${summary.describe.total}`,
  ];
}

/** The tend command the caller ran, with `removed` taken out of `--fail-on`:
 * once a removed code is gone, the rest of the invocation is what the
 * caller asked for. A `--fail-on` with no code left is dropped. */
export function tendCommandWithout(
  removed: ReadonlySet<string>,
  options: { readonly json: boolean; readonly failOn: readonly string[] },
): string {
  const kept = options.failOn.filter((code) => !removed.has(code));
  return [
    "nuka tend",
    ...(options.json ? ["--json"] : []),
    ...(kept.length > 0 ? ["--fail-on", kept.join(",")] : []),
  ].join(" ");
}

export async function runTend(options: RunTendOptions): Promise<number> {
  const { rootDir, json, failOn, stdout, stderr } = options;

  const notices = options.notices ?? [];
  if (options.codes) {
    const entries = listTendCodes().map((entry) =>
      codeFinding({ code: entry.code, severity: "note", description: entry.description, fix: entry.fix }),
    );
    if (json) {
      stdout.write(formatEnvelope("tend", 0, notices, { codes: entries }));
    } else {
      for (const entry of entries) stdout.write(formatFinding(entry));
    }
    return 0;
  }

  // Refused before anything is analyzed: a code tend never emits would
  // otherwise be a flag that never fires, and a team gating a PR on it
  // would read that silence as "nothing to fail on".
  // A removed code is refused too, but by name and with what replaced it,
  // so a CI job written against an earlier release learns where to go.
  const sinks = { json, stdout, stderr, command: "tend" };
  const removed = failOn.filter((code) => REMOVED_TEND_CODES.has(code));
  if (removed.length > 0) {
    const lines = removed.map((code) => `--fail-on: "${code}" ${REMOVED_TEND_CODES.get(code)}.`);
    return refuse(sinks, lines.join(" "), "fail-on-unknown-code", { do: tendCommandWithout(new Set(removed), { json, failOn }) }, notices);
  }
  const unknown = failOn.filter((code) => !TEND_CODES.has(code));
  if (unknown.length > 0) {
    return refuse(
      sinks,
      `--fail-on: ${unknown.map((code) => `"${code}"`).join(", ")} ${unknown.length === 1 ? "is not a code" : "are not codes"} nuka tend reports`,
      "fail-on-unknown-code",
      { do: "nuka tend --codes" },
      notices,
    );
  }

  let report;
  try {
    report = await analyzeTend(rootDir);
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }

  // `--fail-on` turns a chosen note into a red exit for this invocation
  // only; the finding itself stays a note, since what changed is the
  // team's policy, not the finding's nature. Said once per code, so the
  // exit code never changes silently.
  const failOnHits = failOn.flatMap((code) => {
    const count = [...report.errors, ...report.notes].filter((issue) => issue.code === code).length;
    return count > 0 ? [{ code, count }] : [];
  });
  const exitCode = report.errors.length > 0 || failOnHits.length > 0 ? 1 : 0;

  if (json) {
    const findings = [
      ...notices,
      ...report.errors.map((issue) => asJsonFinding("error", issue)),
      ...report.notes.map((issue) => asJsonFinding("note", issue)),
    ];
    stdout.write(formatEnvelope("tend", exitCode, findings, { summary: report.summary, fail_on_hits: failOnHits }));
    return exitCode;
  }
  // Summary first, ahead of the findings, then errors (always empty today,
  // src/tend/analyze.ts's header), then notes, which `analyzeTend` already
  // builds as consecutive per-finding blocks.
  for (const line of formatSummaryLines(report.summary)) {
    stdout.write(`${line}\n`);
  }
  for (const issue of report.errors) stdout.write(formatFinding(tendFinding("error", issue)));
  for (const issue of report.notes) stdout.write(formatFinding(tendFinding("note", issue)));
  if (report.errors.length === 0 && report.notes.length === 0) {
    stdout.write("ok: nothing to tend\n");
  }
  for (const hit of failOnHits) {
    stderr.write(`fail-on: ${hit.code} reported ${hit.count} ${hit.count === 1 ? "finding" : "findings"}\n`);
  }
  return exitCode;
}
