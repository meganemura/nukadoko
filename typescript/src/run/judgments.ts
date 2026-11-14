import { createHash } from "node:crypto";
import type { Finding } from "../finding/finding.js";
import type { RunClaim, RunCitedJudgment, RunJudgedRead, RunJudgmentState, RunRowJudgment, RunScenario, RunTable, RunTableRow } from "../record/run-result.js";
import { equalDifference } from "../report/summary/claim-line.js";
import { shellWord } from "../shell/shell-word.js";
import { ARIA_SNAPSHOT_LABEL } from "../step/claims.js";

// Responsibility: judgments (docs/spec.md "Judgments"), the verdicts on a
// criterion that no compare can give (whether a text is friendly, whether
// a page reads as finished). A Then asks for one with a `judged-as` claim;
// the run reads the value and records it, and a reader judges it after the
// run and commits the judgment. nukadoko checks two things alone, both
// exactly: that a judgment cites a value this run's records hold (by its
// digest), and that the value did not change since. The judgment itself is
// never checked, and never folded into the machine verdict: a row keeps
// its verdict from the cells, and gains a `judgment` beside it, whose
// state has a gate of its own.
//
// Boundary: pure. The judgment files on disk are src/run/judgment-file.ts's,
// recording one is src/cli/judge.ts's, and reading the value is the claim
// runner's (src/step/evaluate-claims.ts).
//
// Why a separate axis and not a verdict word. A judged Then compares
// nothing, so it passes in a control and at the base alike: folded into
// the one verdict, a criterion whose only Then is judged could never be
// proven, and under `--base` a new one was `unproven` whatever its
// judgment said. And a verdict word that a judgment can turn green would
// let a reader mistake a person's or an agent's word for a comparison.
//
// Why a digest of the value the record holds. The record holds the value
// redacted, and a judge reads the record, so the value judged is that one.
// The digest is of its JSON with object keys sorted, so a program that
// writes its keys in another order does not make a judgment stale.

/** One judgment as a judgment file holds it: which claim of which Then of
 * which criterion it judged, the value it judged and its digest, and the
 * judge's verdict and reason. `by` is a name the judge gives, which
 * nothing checks; the commit that adds the entry, and its review, are
 * the record of who judged. */
export interface JudgmentEntry {
  readonly criterion: string;
  readonly then: string;
  readonly claim: number;
  readonly quality: string | null;
  readonly value_digest: string;
  readonly value: unknown;
  readonly verdict: "meets" | "misses";
  readonly because: string;
  readonly by: string;
  readonly run_id: string;
  readonly commit: string | null;
  readonly at: string;
}

/** The JSON of `value` with each object's keys in code-point order, so
 * two values that differ only in key order read the same. Pure. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The digest a judgment cites for a value: `sha256:` and the hex of its
 * canonical JSON. Pure. */
export function valueDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Where a judged value was measured, as a read names it: the channel,
 * with the step record that holds it when that is another step's,
 * `aria-snapshot` for a tree nukadoko took, or `null`. Pure. */
export function measuredOf(claim: Pick<RunClaim, "actual_from" | "measured">, ownRecordId: string | null): string | null {
  if (claim.actual_from.startsWith(ARIA_SNAPSHOT_LABEL)) return "aria-snapshot";
  const measured = claim.measured;
  if (measured === undefined || measured === null) return null;
  return measured.step_record_id === ownRecordId ? measured.channel : `${measured.channel} of ${measured.step_record_id}`;
}

/** A value a run read for a judgment, before it is set against the
 * judgments. */
export type JudgedValue = Omit<RunJudgedRead, "state" | "judgment"> & { readonly value: unknown };

/** Every value the passing required head executions of `row` read for a
 * judgment, once per Then, claim, and value: two environments or two
 * repeats that read the same value need one judgment. Pure. */
export function judgedValues(row: Pick<RunTableRow, "feature" | "line" | "cells">, scenarios: readonly RunScenario[]): JudgedValue[] {
  const required = new Set(row.cells.filter((cell) => cell.world === "head" && cell.role === "required").map((cell) => cell.environment));
  const values: JudgedValue[] = [];
  for (const scenario of scenarios) {
    if (scenario.world !== undefined || scenario.feature !== row.feature || scenario.line !== row.line) continue;
    if (scenario.role === "control" || scenario.status !== "passed" || !required.has(scenario.environment)) continue;
    for (const step of scenario.steps) {
      (step.claims ?? []).forEach((claim, index) => {
        if ("each" in claim || claim.outcome !== "for-judgment" || claim.value_digest === undefined) return;
        const digest = claim.value_digest;
        if (values.some((value) => value.step === step.text && value.claim === index && value.value_digest === digest)) return;
        values.push({
          line: step.line ?? scenario.line,
          step: step.text,
          claim: index,
          environment: scenario.environment,
          quality: claim.expected_text,
          value_from: claim.actual_from,
          value_digest: digest,
          measured: measuredOf(claim, step.step_record_id),
          record: step.record,
          value: claim.actual,
        });
      });
    }
  }
  return values;
}

/** The entries that judge one claim of one Then of one criterion. */
function entriesFor(entries: readonly JudgmentEntry[], criterion: string, value: Pick<JudgedValue, "step" | "claim">): JudgmentEntry[] {
  return entries.filter((entry) => entry.criterion === criterion && entry.then === value.step && entry.claim === value.claim);
}

function cited(entry: JudgmentEntry, extra: Pick<RunCitedJudgment, "value" | "difference"> = {}): RunCitedJudgment {
  return { value_digest: entry.value_digest, verdict: entry.verdict, by: entry.by, because: entry.because, run_id: entry.run_id, at: entry.at, ...extra };
}

/** Where one value stands against the judgments of its criterion: a
 * value in no recorded channel is `uncitable` whatever a file says; an
 * entry with its digest decides it; entries of the same claim that cite
 * only values this run did not read make it `stale`, citing the latest
 * of them; otherwise it is `pending`. `readNow` is every digest the run
 * read for the same claim: a value one environment reads beside a judged
 * value another reads (a greeting in two languages) is a value of its
 * own to judge, not the judged one gone stale. Pure. */
export function readAgainst(value: JudgedValue, criterion: string, entries: readonly JudgmentEntry[], readNow: readonly string[] = [value.value_digest]): RunJudgedRead {
  const { value: read, ...rest } = value;
  if (value.measured === null) return { ...rest, state: "uncitable" };
  const same = entriesFor(entries, criterion, value);
  const match = same.find((entry) => entry.value_digest === value.value_digest);
  if (match !== undefined) return { ...rest, state: match.verdict === "meets" ? "judged" : "misses", judgment: cited(match) };
  if (same.length === 0 || same.some((entry) => readNow.includes(entry.value_digest))) return { ...rest, state: "pending" };
  const latest = [...same].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
  const difference = equalDifference(read, latest.value);
  return { ...rest, state: "stale", judgment: cited(latest, { value: latest.value, ...(difference === null ? {} : { difference }) }) };
}

/** Each value of one criterion against its judgments, each knowing what
 * else the run read for the same claim. Pure. */
export function readEach(values: readonly JudgedValue[], criterion: string, entries: readonly JudgmentEntry[]): RunJudgedRead[] {
  const readNow = (value: JudgedValue): string[] => values.filter((other) => other.step === value.step && other.claim === value.claim).map((other) => other.value_digest);
  return values.map((value) => readAgainst(value, criterion, entries, readNow(value)));
}

/** The order a row's state is chosen in: a judge's no first, then what no
 * judgment can fix, then what a new judgment fixes. */
const STATE_ORDER: readonly RunJudgmentState[] = ["misses", "uncitable", "stale", "pending", "judged"];

/** A value as a reason quotes it, cut at 120 characters of its JSON. */
export function valuePreview(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function quality(read: Pick<RunJudgedRead, "quality">): string {
  return read.quality ?? "what the sentence says";
}

/** One read's clause in a row's reason, by its state. */
function readClause(read: RunJudgedRead, value: unknown): string {
  const at = `line ${read.line}`;
  const judgment = read.judgment;
  switch (read.state) {
    case "judged":
      return `${judgment!.by} judged the value ${at} read as ${quality(read)}: ${judgment!.because}`;
    case "misses":
      return `${judgment!.by} judged the value ${at} read, ${valuePreview(value)}, not ${quality(read)}: ${judgment!.because}`;
    case "uncitable":
      return `${at} asks for a judgment of ${read.value_from}, which no channel of a step record holds, so no judgment can cite it`;
    case "stale":
      // Where the two differ says more than two cut previews of a long
      // value, which can read the same.
      return judgment!.difference === undefined
        ? `${at} read ${valuePreview(value)}, and the judgment by ${judgment!.by} in ${judgment!.run_id} cited ${valuePreview(judgment!.value)}, so it does not cover what ran`
        : `${at} read another value than the one the judgment by ${judgment!.by} in ${judgment!.run_id} cited, so it does not cover what ran; ${judgment!.difference} (actual is this run's value, expected the judged one)`;
    case "pending":
      return `${at} read ${valuePreview(value)} for a judgment as ${quality(read)}, and no judgment cites it`;
  }
}

/** The judgment of one row: each value against the entries, the state
 * the first value in `STATE_ORDER` decides, and why. `undefined` for a
 * row that read no value for a judgment. Pure. */
export function rowJudgment(row: Pick<RunTableRow, "feature" | "line" | "name" | "cells">, scenarios: readonly RunScenario[], entries: readonly JudgmentEntry[]): RunRowJudgment | undefined {
  const values = judgedValues(row, scenarios);
  if (values.length === 0) return undefined;
  const reads = readEach(values, row.name, entries);
  const state = STATE_ORDER.find((candidate) => reads.some((read) => read.state === candidate))!;
  const shown = reads.flatMap((read, index) => (read.state === state ? [readClause(read, values[index]!.value)] : []));
  return { state, reason: shown.join("; "), reads };
}

/** The table with a `judgment` on each row whose required head cells all
 * passed and read a value for a judgment. A row whose head did not pass
 * keeps none: what it read is not the criterion holding, and its verdict
 * is red already. The verdict is never touched. Pure. */
export function withJudgments(table: RunTable, scenarios: readonly RunScenario[], entriesOf: (feature: string) => readonly JudgmentEntry[]): RunTable {
  const rows = table.rows.map((row): RunTableRow => {
    const required = row.cells.filter((cell) => cell.world === "head" && cell.role === "required");
    if (required.length === 0 || required.some((cell) => cell.outcome !== "pass")) return row;
    const judgment = rowJudgment(row, scenarios, entriesOf(row.feature));
    return judgment === undefined ? row : { ...row, judgment };
  });
  return { ...table, rows };
}

/** Whether the judgments leave the gate red: a row whose judgment is
 * anything but `judged`. Pure. */
export function judgmentsOpen(table: Pick<RunTable, "rows">): boolean {
  return table.rows.some((row) => row.judgment !== undefined && row.judgment.state !== "judged");
}

/** The command that shows what a criterion asks a judge, for the run that
 * read it: it prints and records nothing, so it is a `do:`. */
export function showCommand(row: Pick<RunTableRow, "feature" | "line">, runId: string): string {
  return ["nuka", "judge", `${row.feature}:${row.line}`, "--run", runId].map(shellWord).join(" ");
}

const RECORD_FIX =
  "a judge who did not write the change reads the value against the sentence, then records it with nuka judge and --meets or --misses, --by, and --because";

/** One finding per row whose judgment leaves the gate red, with its code
 * (`judgment-<state>`), its reason, and what closes it. Pure. */
export function judgmentFindings(table: Pick<RunTable, "rows">, runId: string): Finding[] {
  return table.rows.flatMap((row): Finding[] => {
    const judgment = row.judgment;
    if (judgment === undefined || judgment.state === "judged") return [];
    const base = { severity: "failed" as const, code: `judgment-${judgment.state}`, file: row.feature, line: row.line, message: `Scenario "${row.name}" ${judgment.reason}` };
    switch (judgment.state) {
      case "uncitable":
        return [
          {
            ...base,
            fix: "read the value whole from a channel the step record holds (a response, a process's output, a file) and narrow it with view and at, or return the locator or page from observe so nukadoko takes its ARIA snapshot",
          },
        ];
      case "misses":
        return [{ ...base, fix: "change the program until the value meets the sentence, then run it again and have it judged again", do: showCommand(row, runId) }];
      default:
        return [{ ...base, fix: RECORD_FIX, do: showCommand(row, runId) }];
    }
  });
}

/** `entries` with `entry` in: it replaces an entry that judged the same
 * value of the same claim, and is added beside the entries of other
 * values, so a value that comes back finds its judgment again. Pure. */
export function addJudgment(entries: readonly JudgmentEntry[], entry: JudgmentEntry): JudgmentEntry[] {
  const same = (other: JudgmentEntry): boolean =>
    other.criterion === entry.criterion && other.then === entry.then && other.claim === entry.claim && other.value_digest === entry.value_digest;
  return [...entries.filter((other) => !same(other)), entry];
}

/** A judgment file's text: its entries ordered by criterion, Then, claim,
 * and time, so two judges who add one each make a diff of two hunks. */
export function judgmentFileText(entries: readonly JudgmentEntry[]): string {
  const ordered = [...entries].sort(
    (a, b) => a.criterion.localeCompare(b.criterion) || a.then.localeCompare(b.then) || a.claim - b.claim || a.at.localeCompare(b.at) || a.value_digest.localeCompare(b.value_digest),
  );
  return `${JSON.stringify({ judgments: ordered }, null, 2)}\n`;
}

const ENTRY_STRINGS = ["criterion", "then", "value_digest", "because", "by", "run_id", "at"] as const;

/** A judgment file's entries, or why its text holds none: a file a person
 * edited by hand can break, and a judgment it no longer holds must read
 * as unread, never as absent. Pure. */
export function parseJudgmentFile(text: string): { readonly entries: readonly JudgmentEntry[] } | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: `it is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const list = (parsed as { judgments?: unknown } | null)?.judgments;
  if (!Array.isArray(list)) return { problem: "it holds no judgments array" };
  for (const [index, raw] of list.entries()) {
    const entry = raw as Record<string, unknown> | null;
    const missing = entry === null || typeof entry !== "object" ? "an object" : ENTRY_STRINGS.find((key) => typeof entry[key] !== "string");
    if (missing !== undefined) return { problem: `judgments[${index}] ${missing === "an object" ? "is not an object" : `has no text ${missing}`}` };
    if (typeof entry!.claim !== "number" || (entry!.verdict !== "meets" && entry!.verdict !== "misses")) {
      return { problem: `judgments[${index}] needs a claim number and a verdict of meets or misses` };
    }
  }
  return { entries: list as JudgmentEntry[] };
}
