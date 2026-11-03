import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import type { Finding } from "../finding/finding.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { readEndedRuns, type RunDocument, type RunJudgedRead, type RunTableRow } from "../record/run-result.js";
import { readJudgmentFile, writeJudgmentFile } from "../run/judgment-file.js";
import { addJudgment, judgedValues, readEach, valueDigest, type JudgedValue, type JudgmentEntry } from "../run/judgments.js";
import { shellWord } from "../shell/shell-word.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { formatEnvelope, refuse } from "./refusal.js";

// Responsibility: `nuka judge <file>:<line>`, the one way a judgment gets
// into a judgment file (docs/spec.md "Judgments"). Without a verdict flag
// it shows what the criterion asks a judge: each value its Then read, the
// quality the sentence names, and where the record keeps the value and
// the view of the page around it. With `--meets` or `--misses`, `--by`,
// and `--because` it records one judgment of each of those values.
//
// Boundary: it checks what a machine can, and only that: the run judged
// this criterion, its required head cells passed, each value is in a
// channel nukadoko recorded, and the value the step record holds has the
// digest run.json recorded for it, so a judgment can only cite a value a
// run wrote down, never one typed in or edited into one of the two files.
// It never checks the judgment, nor who made it: `--by` is a name, and the
// commit that adds the file, with its review, is the record of who judged.
//
// It shows and records; it never runs. A judgment is of the value a run
// read, so the judge reads that run's record, and the next run reads the
// criterion against the file.

export interface JudgeOptions {
  readonly rootDir: string;
  readonly target: string;
  /** A run id; the newest run that ended when absent. */
  readonly run?: string;
  /** `undefined`: show, record nothing. */
  readonly verdict?: "meets" | "misses";
  readonly by?: string;
  readonly because?: string;
  readonly json: boolean;
  readonly notices?: readonly Finding[];
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
}

/** The criterion a target names: `<feature file>:<scenario line>`. */
export function parseTarget(target: string): { readonly feature: string; readonly line: number } | null {
  const match = /^(.+):([1-9][0-9]*)$/.exec(target);
  return match === null ? null : { feature: match[1]!.split(path.sep).join("/"), line: Number(match[2]) };
}

/** What a judge is shown of one value, and what a judgment cites. */
export interface ShownValue {
  readonly read: RunJudgedRead;
  readonly value: unknown;
  /** The files of the view of the page right after the Then read it,
   * relative to the run directory; none for a Then that read no page. */
  readonly seen: readonly string[];
}

/** Why `row` of `run` cannot be judged, or `null`. Pure. */
export function unjudgeable(row: RunTableRow | undefined, target: string, run: RunDocument, values: readonly JudgedValue[]): string | null {
  if (row === undefined) return `${run.run_id} ran no criterion at ${target}`;
  const required = row.cells.filter((cell) => cell.world === "head" && cell.role === "required");
  if (required.length === 0 || required.some((cell) => cell.outcome !== "pass")) {
    return `${target} did not pass in ${run.run_id} (${row.reason}), and only a criterion whose required cells passed has a value to judge`;
  }
  if (values.length === 0) return `${target} asks for no judgment in ${run.run_id}: no Then of it has a judged-as claim that read a value`;
  return null;
}

/** Why the value a step record holds for a read is not the one run.json
 * recorded, or `null` when the two agree. Pure. */
export function recordDisagrees(read: Pick<JudgedValue, "record" | "claim" | "value_digest">, record: unknown): string | null {
  const claims = (record as { claims?: unknown } | null)?.claims;
  const claim = Array.isArray(claims) ? (claims[read.claim] as Record<string, unknown> | undefined) : undefined;
  if (claim === undefined || claim === null || typeof claim !== "object" || !Object.hasOwn(claim, "actual")) {
    return `${read.record ?? "the step record"} holds no value for claim ${read.claim}`;
  }
  if (claim.outcome !== "for-judgment") return `${read.record ?? "the step record"} records claim ${read.claim} as ${String(claim.outcome)}, not for-judgment`;
  const digest = valueDigest(claim.actual);
  return digest === read.value_digest ? null : `${read.record ?? "the step record"} holds a value whose digest is ${digest}, and run.json recorded ${read.value_digest}, so the two records disagree`;
}

function runNamed(runs: readonly RunDocument[], name: string | undefined): RunDocument | undefined {
  if (name === undefined) return rankRunsNewestFirst(runs)[0]?.run;
  return runs.find((run) => run.run_id === name || run.run_dir === name || path.basename(run.run_dir ?? "") === name);
}

function seenOf(document: RunDocument, read: RunJudgedRead): string[] {
  const scenario = document.scenarios.find((entry) => entry.world === undefined && entry.environment === read.environment && entry.steps.some((step) => step.line === read.line && step.text === read.step));
  const step = scenario?.steps.find((entry) => entry.line === read.line && entry.text === read.step);
  return (step?.judged_view?.pages ?? []).flatMap((page) => [page.screenshot?.file, page.aria?.file].filter((file): file is string => typeof file === "string"));
}

function valueBlock(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.split("\n").map((line) => `    ${line}`);
}

function showText(target: string, row: RunTableRow, run: RunDocument, shown: readonly ShownValue[]): string {
  const lines = [`${target} "${row.name}" in ${run.run_id}: ${shown.length === 1 ? "1 value" : `${shown.length} values`} to judge`];
  for (const { read, value, seen } of shown) {
    lines.push(`- line ${read.line} "${read.step}", claim ${read.claim}, in ${read.environment}: ${read.state}`);
    lines.push(`  quality: ${read.quality ?? "the sentence"}`);
    lines.push(`  value, ${read.value_from}, measured ${read.measured ?? "none"}:`);
    lines.push(...valueBlock(value));
    lines.push(`  digest: ${read.value_digest}`);
    if (read.record !== null) lines.push(`  record: ${path.posix.join(run.run_dir ?? "", read.record, "record.json")}`);
    if (seen.length > 0) lines.push(`  seen: ${seen.map((file) => path.posix.join(run.run_dir ?? "", file)).join(", ")}`);
    if (read.judgment !== undefined) lines.push(`  judgment: ${read.judgment.verdict} by ${read.judgment.by} in ${read.judgment.run_id}: ${read.judgment.because}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runJudge(options: JudgeOptions): Promise<number> {
  const { rootDir, json, stdout, stderr } = options;
  const notices = options.notices ?? [];
  const sinks = { json, stdout, stderr, command: "judge" };
  const refused = (message: string, fix?: string, next?: string): number =>
    refuse(sinks, new Error(message), "judgment-refused", fix === undefined && next === undefined ? undefined : { ...(fix === undefined ? {} : { fix }), ...(next === undefined ? {} : { do: next }) }, notices);

  const place = parseTarget(options.target);
  if (place === null) return refused(`${options.target} names no criterion: write it as <feature file>:<scenario line>`);
  const recording = options.verdict !== undefined;
  if (recording && ((options.by ?? "").trim() === "" || (options.because ?? "").trim() === "")) {
    return refused("a judgment needs --by, the judge's name, and --because, why the value meets or misses the sentence, in one sentence");
  }
  if (recording && /[\r\n]/.test(options.because ?? "")) return refused("--because is one sentence, on one line");

  let stateDir: string;
  try {
    stateDir = (await loadConfig(rootDir)).stateDir;
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }
  const target = `${place.feature}:${place.line}`;
  const run = runNamed(readEndedRuns(rootDir, stateDir), options.run);
  if (run === undefined) {
    return refused(options.run === undefined ? "no run has ended in this project, so no value was read to judge" : `no run that ended is named ${options.run}`, undefined, ["nuka", "run", target].map(shellWord).join(" "));
  }
  const row = run.table.rows.find((entry) => entry.feature === place.feature && entry.line === place.line);
  const values = row === undefined ? [] : judgedValues(row, run.scenarios);
  const why = unjudgeable(row, target, run, values);
  if (why !== null) return refused(why, undefined, ["nuka", "run", target].map(shellWord).join(" "));

  const file = readJudgmentFile(rootDir, place.feature);
  if ("problem" in file) return refused(`the judgments of ${place.feature} were not read: ${file.problem}`);
  const runDir = path.join(rootDir, run.run_dir ?? path.join(stateDir, "runs", run.run_id));
  const shown: ShownValue[] = [];
  const reads = readEach(values, row!.name, file.entries);
  for (const [index, value] of values.entries()) {
    const read = reads[index]!;
    if (recording && read.state === "uncitable") {
      return refused(`line ${read.line} read ${read.value_from}, which no channel of a step record holds, so a judgment cannot cite it`);
    }
    if (recording) {
      let record: unknown;
      try {
        record = JSON.parse(readFileSync(path.join(runDir, value.record ?? "", "record.json"), "utf8"));
      } catch (error) {
        return refused(`${run.run_id} holds no readable step record for line ${value.line}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const disagree = recordDisagrees(value, record);
      if (disagree !== null) {
        return refused(disagree, "a run's records changed after it ended, so neither can be cited: run the criterion again, and judge the value the new run reads", ["nuka", "run", target].map(shellWord).join(" "));
      }
    }
    shown.push({ read, value: value.value, seen: seenOf(run, read) });
  }

  if (!recording) {
    if (json) {
      stdout.write(
        formatEnvelope("judge", 0, notices, {
          run_id: run.run_id,
          feature: place.feature,
          line: place.line,
          criterion: row!.name,
          values: shown.map(({ read, value, seen }) => ({ ...read, value, seen })),
        }),
      );
    } else {
      stdout.write(showText(target, row!, run, shown));
      stdout.write(`  fix: judge each value against its quality, then record it: nuka judge ${shellWord(target)} --run ${run.run_id} --meets or --misses --by <who> --because <one sentence>\n`);
    }
    return 0;
  }

  let entries: readonly JudgmentEntry[] = file.entries;
  const at = new Date().toISOString();
  for (const { read, value } of shown) {
    entries = addJudgment(entries, {
      criterion: row!.name,
      then: read.step,
      claim: read.claim,
      quality: read.quality,
      value_digest: read.value_digest,
      value,
      verdict: options.verdict!,
      because: options.because!.trim(),
      by: options.by!.trim(),
      run_id: run.run_id,
      commit: run.commit?.sha ?? null,
      at,
    });
  }
  const written = writeJudgmentFile(rootDir, place.feature, entries);
  const next = ["nuka", "run", target].map(shellWord).join(" ");
  if (json) {
    stdout.write(formatEnvelope("judge", 0, notices, { run_id: run.run_id, feature: place.feature, line: place.line, verdict: options.verdict, file: written, value_digests: shown.map(({ read }) => read.value_digest), do: next }));
    return 0;
  }
  for (const { read } of shown) stdout.write(`${options.verdict}\t${target}\tline ${read.line} claim ${read.claim}\t${read.value_digest}\n`);
  stderr.write(`wrote ${written}: commit it, so its review records who judged; the next run reads ${target} against it\n  do: ${next}\n`);
  return 0;
}
