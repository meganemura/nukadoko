import { loadConfig } from "../config/load-config.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { readEndedRuns, type RunDocument } from "../record/run-result.js";
import { probeWorkingTree } from "../run/probe-git.js";
import { shellWord } from "../shell/shell-word.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { FAILED_EXIT_CODE, formatEnvelope, refuse, withHint } from "./refusal.js";

// Responsibility: `nuka verdict`, the question an agent asks before it says
// a change is done: does the newest run that ended speak for the working
// tree as it is now, and does it leave anything red. It answers from
// run.json and one git tree id. Boundary: it reads, and never starts a
// run. A run can take minutes and open a browser, and which features and
// which base to run is the caller's call; a command that ran one on every
// question would make a host's stop hook that slow, and would decide both.
//
// What it does not claim. A pass says the newest run judged exactly this
// tree and left no criterion failed, unproven, or moved. It does not say
// the change has a criterion of its own: a change no scenario touches
// passes as long as the old ones still hold. It does not say which files
// the run named either; a run of one feature file is a full run of that
// file. Under `--base` the `criteria-unchanged` note says when no
// criterion is new or changed, which is the one part of that a record can
// state; whether the change needed one is the person's question.
//
// The red findings are the newest run's own, as it printed them, and not
// a reading of the table: the run already gave every red row its code and
// its next command, so a second wording here could only drift from it.
// They are relayed only when the run judged this tree: a red row of an
// earlier tree may be fixed already, and a green one may not hold now.

export interface RunVerdictOptions {
  rootDir: string;
  json: boolean;
  /** Findings a caller raised before the command ran (no config file), put
   * first in the envelope. */
  notices?: readonly Finding[];
  stdout: WritableSink;
  stderr: WritableSink;
}

/** Whether the newest run judged the working tree there is now. */
export type Judged =
  /** No run in this project has ended. */
  | "missing"
  /** The newest run recorded another tree, or none. */
  | "stale"
  /** The newest run recorded this tree. */
  | "judged"
  /** The working tree has no id (outside git, before the first commit, or
   * a git call failed), so nothing can be compared. */
  | "unknown";

export interface VerdictAnswer {
  readonly judged: Judged;
  readonly findings: readonly Finding[];
}

/** The tree id the run recorded, when it is one. A run.json an earlier
 * build wrote has none, and a hand-edited one may hold anything. */
export function runWorkingTree(run: RunDocument): string | undefined {
  const tree = (run.commit as { working_tree?: unknown } | null)?.working_tree;
  return typeof tree === "string" && tree !== "" ? tree : undefined;
}

/** The run's table, which a run.json from before the verdict table
 * lacks; such a run judged no criterion as new. */
function tableOf(run: RunDocument): Pick<RunDocument["table"], "base" | "rows"> {
  const table = run.table as RunDocument["table"] | undefined;
  return { base: table?.base ?? null, rows: table?.rows ?? [] };
}

/** `nuka run`, with the base the newest run compared with, so the line
 * that judges the tree again keeps judging new criteria as new. */
function runAgain(newest: RunDocument | undefined): string {
  const base = newest === undefined ? undefined : tableOf(newest).base?.ref;
  return ["nuka", "run", ...(base === undefined ? [] : ["--base", base])].map(shellWord).join(" ");
}

function staleMessage(newest: RunDocument, recorded: string | undefined, workingTree: string): string {
  const then = `the newest run ${newest.run_id} (started ${newest.started_at})`;
  if (recorded === undefined) {
    return `${then} recorded no working tree id (outside git then, or written by an earlier nukadoko), so it cannot be matched to the working tree ${workingTree.slice(0, 12)}`;
  }
  return `${then} judged working tree ${recorded.slice(0, 12)}, and the working tree is now ${workingTree.slice(0, 12)}: its verdicts say nothing about what changed since`;
}

/**
 * The answer for `newest`, the newest run that ended, and `workingTree`,
 * the working tree's id now. Pure: the caller reads the run and probes git.
 * Exit 1 follows any `failed` or `error` finding; a note never blocks.
 */
export function judgeWorkingTree(newest: RunDocument | undefined, workingTree: string | undefined): VerdictAnswer {
  if (newest === undefined) {
    return {
      judged: "missing",
      findings: [{ severity: "failed", code: "run-missing", message: "no nuka run has ended in this project, so nothing judged this working tree", do: runAgain(undefined) }],
    };
  }
  const recorded = runWorkingTree(newest);
  if (workingTree !== undefined && recorded !== workingTree) {
    return {
      judged: "stale",
      findings: [{ severity: "failed", code: "run-stale", message: staleMessage(newest, recorded, workingTree), do: runAgain(newest) }],
    };
  }

  const findings: Finding[] = [];
  if (workingTree === undefined) {
    // A pass here would be a guess about the tree, and a block would ask
    // for a run that cannot settle it either; the note says what was not
    // seen, and the verdict rests on the table alone.
    findings.push({
      severity: "note",
      code: "working-tree-unknown",
      message: `git gave no id for the working tree (outside a repository, before its first commit, or a git call failed), so whether the newest run ${newest.run_id} judged it is unknown; the verdict below is that run's own`,
    });
  }
  if (newest.walk !== undefined) {
    findings.push({
      severity: "failed",
      code: "run-partial",
      message: `the newest run ${newest.run_id} was a walk (nuka run --step): between its steps the world and the browser were open to anything, so it explored the scenario rather than judged it`,
      do: runAgain(newest),
    });
  } else if (newest.selection === "partial") {
    findings.push({
      severity: "failed",
      code: "run-partial",
      message: `the newest run ${newest.run_id} left out scenarios of the files it named (a :line target or --tag), so the criteria it left out were not judged`,
      do: runAgain(newest),
    });
  }
  const red = (newest.findings ?? []).filter((finding) => finding.severity === "failed" || finding.severity === "error");
  findings.push(...red);
  if (newest.verdict === "failed" && red.length === 0) {
    findings.push({
      severity: "failed",
      code: "run-failed",
      message: `the newest run ${newest.run_id} failed, and its run.json holds no failed finding that says why`,
      do: ["nuka", "report", newest.run_dir ?? newest.run_id, "--format", "markdown"].map(shellWord).join(" "),
    });
  }
  const { base, rows } = tableOf(newest);
  if (base === null) {
    findings.push({
      severity: "note",
      code: "run-without-base",
      message: `the newest run ${newest.run_id} had no --base, so no row says which criteria are new or changed, and a new one that passes without the change was not caught`,
    });
  } else if (!rows.some((row) => row.change === "new" || row.change === "changed")) {
    findings.push({
      severity: "note",
      code: "criteria-unchanged",
      message: `no criterion is new or changed since ${base.ref}: the run shows the criteria that were there still hold, not that the change does what it was for`,
    });
  }
  return { judged: workingTree === undefined ? "unknown" : "judged", findings };
}

export function isOpen(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === "failed" || finding.severity === "error");
}

/** The line before the findings: what the newest run speaks for, in words. */
export function headline(answer: VerdictAnswer, newest: RunDocument | undefined): string {
  const open = isOpen(answer.findings);
  switch (answer.judged) {
    case "missing":
      return "failed: no run has ended, so nothing judged this working tree";
    case "stale":
      return `failed: the newest run, ${newest!.run_id}, judged another working tree`;
    case "unknown":
      return `${open ? "failed" : "passed"}: the newest run, ${newest!.run_id}, ${open ? "leaves open what is below" : "left nothing red"}; whether it judged this working tree is unknown`;
    case "judged":
      return open
        ? `failed: the newest run, ${newest!.run_id}, judged this working tree, and it leaves open what is below`
        : `passed: the newest run, ${newest!.run_id}, judged this working tree and left nothing red`;
  }
}

export async function runVerdict(options: RunVerdictOptions): Promise<number> {
  const { rootDir, json, stdout, stderr } = options;
  const notices = options.notices ?? [];
  const sinks = { json, stdout, stderr, command: "verdict" };
  let stateDir: string;
  try {
    stateDir = (await loadConfig(rootDir)).stateDir;
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }

  // The tree is probed before the runs are read: a run that ends in
  // between is then judged against the tree as it was before it, which
  // can only make the answer stale, never wrongly fresh.
  const workingTree = await probeWorkingTree(rootDir, stateDir);
  const newest = rankRunsNewestFirst(readEndedRuns(rootDir, stateDir))[0]?.run;
  const answer = judgeWorkingTree(newest, workingTree);
  const exitCode = isOpen(answer.findings) ? FAILED_EXIT_CODE : 0;

  if (json) {
    stdout.write(
      formatEnvelope("verdict", exitCode, [...notices, ...answer.findings], {
        judged: answer.judged,
        working_tree: workingTree ?? null,
        run_id: newest?.run_id ?? null,
        run_dir: newest === undefined ? null : (newest.run_dir ?? null),
        run_working_tree: newest === undefined ? null : (runWorkingTree(newest) ?? null),
        base: newest === undefined ? null : tableOf(newest).base,
      }),
    );
    return exitCode;
  }
  stdout.write(`${headline(answer, newest)}\n`);
  for (const finding of answer.findings) stdout.write(formatFinding(withHint(finding)));
  return exitCode;
}
