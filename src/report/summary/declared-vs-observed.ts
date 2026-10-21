import type { ProcessEntry, StepRecord } from "../../record/types.js";

// Responsibility: the "Declared vs observed" section of the run summary
// `nuka run` writes (src/run/run-summary.ts), the Markdown a person reads
// about a run. Pure: callers hand in the step records they already read,
// and decide for themselves what a missing one means (a run summary skips
// a step that never ran).
//
// The section sets a step's declaration (`mutates`) against what was
// measured (`observed.http_writes`, and the files that changed under the
// working directory of each process the step ran,
// `observed.processes[].files`) and states only the raw fact, never a
// verdict. A file change is a measurement, not a proxy, but it is a change
// in a directory, not proof that the step's own process made it, so it is
// stated the same way. A step reading over POST lands here every time, by design: the
// HTTP method is not a trustworthy signal of a write, which is the same
// reason run-time `mutates` enforcement was dropped. So this section is a
// record, not an accusation. A read-only step that reached neither an HTTP
// channel nukadoko observes (`observed.http_writes` is `null`) nor a
// process whose files were measured was not compared, and the section
// counts those apart so "no write" is never claimed for a step that called
// `fetch` or wrote a file itself.

/** One step that ran and has a step record to compare. */
export interface ComparedStep {
  readonly scenarioName: string;
  readonly stepText: string;
  readonly stepRecord: Pick<StepRecord, "mutates" | "observed">;
}

/** One step whose step record declared `mutates: false` but was measured
 * making at least one write. */
export interface DeclaredVsObservedMismatch {
  readonly scenarioName: string;
  readonly stepText: string;
  /** Measured HTTP writes, 0 when the step reached HTTP and wrote nothing
   * or reached no HTTP channel. */
  readonly writes: number;
  /** Each file change under a process's working directory, as
   * `<added|changed|removed> <cwd>/<path>`, in process order. */
  readonly fileChanges: readonly string[];
}

/** The file changes of every process whose files were measured, and
 * whether any was: a process with `unmeasured` files, or one recorded by a
 * release before this field, compares nothing. */
function fileChangesOf(processes: readonly ProcessEntry[] | null): { measured: boolean; changes: string[] } {
  let measured = false;
  const changes: string[] = [];
  for (const entry of processes ?? []) {
    const files = entry.files;
    if (files === undefined || "unmeasured" in files) continue;
    measured = true;
    const base = entry.cwd.replaceAll("\\", "/").replace(/\/$/, "");
    for (const [change, paths] of [["added", files.added], ["changed", files.changed], ["removed", files.removed]] as const) {
      for (const path of paths) changes.push(`${change} ${base}/${path}`);
    }
  }
  return { measured, changes };
}

const MAX_LISTED_FILE_CHANGES = 3;

export interface DeclaredVsObserved {
  readonly mismatches: readonly DeclaredVsObservedMismatch[];
  /** Compat steps carry `mutates: null`: nothing to compare, which is a
   * different fact from "compared and matched", so it is counted apart. */
  readonly compatStepCount: number;
  /** Steps that declared `mutates: false` and reached no HTTP channel
   * nukadoko observes, so there was nothing to compare. */
  readonly unobservedReadOnlyCount: number;
  /** Steps whose step record could not be read, so nothing is known to
   * compare: counted so they are not read as compared and matched. */
  readonly unreadableCount: number;
}

export function collectDeclaredVsObserved(steps: Iterable<ComparedStep>, unreadableCount = 0): DeclaredVsObserved {
  const mismatches: DeclaredVsObservedMismatch[] = [];
  let compatStepCount = 0;
  let unobservedReadOnlyCount = 0;
  for (const { scenarioName, stepText, stepRecord } of steps) {
    if (stepRecord.mutates === null) {
      compatStepCount += 1;
      continue;
    }
    if (stepRecord.mutates !== false) continue;
    const writes = stepRecord.observed.http_writes;
    const files = fileChangesOf(stepRecord.observed.processes);
    if (writes === null && !files.measured) {
      unobservedReadOnlyCount += 1;
    } else if ((writes ?? 0) > 0 || files.changes.length > 0) {
      mismatches.push({ scenarioName, stepText, writes: writes ?? 0, fileChanges: files.changes });
    }
  }
  return { mismatches, compatStepCount, unobservedReadOnlyCount, unreadableCount };
}

/** One roll-up section rather than a note per scenario: a per-scenario note
 * is what a reader scrolling past scenario after scenario misses. Always
 * present, even with no mismatch, so "compared, found nothing" stays
 * distinguishable from "never compared". */
export function renderDeclaredVsObserved(result: DeclaredVsObserved): string[] {
  const { mismatches, compatStepCount, unobservedReadOnlyCount, unreadableCount } = result;
  const lines: string[] = ["", "## Declared vs observed", ""];

  if (mismatches.length === 0) {
    lines.push("No step declared `mutates: false` and was measured making a write or changing a file.");
  } else {
    lines.push(
      "Steps that declared `mutates: false` and were measured making writes or changing files. This is a comparison, not a verdict: a step that reads over POST records writes by design, and a file change is a change under a process's working directory, whoever made it.",
      "",
    );
    for (const mismatch of mismatches) {
      const observed: string[] = [];
      if (mismatch.writes > 0) observed.push(`${mismatch.writes} ${mismatch.writes === 1 ? "write" : "writes"}`);
      const count = mismatch.fileChanges.length;
      if (count > 0) {
        const listed = mismatch.fileChanges.slice(0, MAX_LISTED_FILE_CHANGES).join(", ");
        const more = count > MAX_LISTED_FILE_CHANGES ? `, and ${count - MAX_LISTED_FILE_CHANGES} more in its step record` : "";
        observed.push(`${count} file ${count === 1 ? "change" : "changes"} (${listed}${more})`);
      }
      lines.push(
        `- "${mismatch.stepText}" (scenario "${mismatch.scenarioName}"): declared mutates: false, observed ${observed.join(" and ")}`,
      );
    }
  }

  if (unobservedReadOnlyCount > 0) {
    const subject =
      unobservedReadOnlyCount === 1
        ? "1 step that declared `mutates: false` reached"
        : `${unobservedReadOnlyCount} steps that declared \`mutates: false\` reached`;
    lines.push(
      "",
      `${subject} no HTTP channel nukadoko observes (\`request\`, \`page\`, \`context\`, \`pageAs\`) and ran no process through \`runCommand\` whose files were measured, so nothing was compared for ${unobservedReadOnlyCount === 1 ? "it" : "them"}.`,
    );
  }

  if (unreadableCount > 0) {
    const subject = unreadableCount === 1 ? "1 step has a step record" : `${unreadableCount} steps have step records`;
    lines.push("", `${subject} nukadoko could not read, so nothing was compared for ${unreadableCount === 1 ? "it" : "them"}.`);
  }

  if (compatStepCount > 0) {
    const stepWord = compatStepCount === 1 ? "step" : "steps";
    const verb = compatStepCount === 1 ? "has" : "have";
    lines.push("", `${compatStepCount} compat ${stepWord} ${verb} no \`mutates\` declaration to compare.`);
  }

  return lines;
}
