import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ObservedCounts, ProcessEntry, ProcessOutput } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { processOutputFileName } from "./process-output.js";

// Responsibility: what one step boundary reached outside its own process,
// the step record's `observed` (docs/spec.md "Records"): the processes
// `runCommand` (run-command.ts) started. What each process printed is
// written as files beside the step record (process-output.ts), redacted,
// and the entry names them: output can be large, and the entry run.json
// copies stays small.
//
// Owned and reset by the executor's step boundary (create-context.ts's
// `beginStep`) — never reachable from a
// step's own `run`, the same trust-model rule every other evidence-
// collecting piece of `ctx` already follows (docs/spec.md: a step cannot
// control its own step record or evidence collection).

export interface ObservedCollector {
  /** Takes the next position in the process list when a process starts
   * (the list is `null` until the boundary's first `runCommand` call), and
   * returns the function that fills it when the process ends. Entries
   * therefore appear in start order, whatever order the processes finish
   * in. A position never filled (the process was still running when the
   * step record was built) is left out of the snapshot. */
  startProcess(): (entry: ProcessEntry, output?: ProcessOutput) => void;
  /** Directories `runCommand` leaves out of its file snapshot. */
  readonly unwatchedDirs: readonly string[];
  /** A snapshot of what was recorded since the last `reset()` (or since
   * creation, for `nuka do`'s single execution-wide boundary). */
  snapshot(): ObservedCounts;
  /** Executor-only: starts a new step boundary. */
  reset(): void;
}

export function createObservedCollector(
  options: {
    readonly unwatchedDirs?: readonly string[];
    /** The current step boundary's evidence directory. Without it, output
     * is not kept. */
    readonly outputDir?: () => string;
    readonly secrets?: SecretSet;
  } = {},
): ObservedCollector {
  let processes: (ProcessEntry | undefined)[] | null = null;

  return {
    unwatchedDirs: options.unwatchedDirs ?? [],
    startProcess(): (entry: ProcessEntry, output?: ProcessOutput) => void {
      // Captured, not re-read at fill time: a process that outlives a reset
      // fills the list it started in, never the next step's, and writes its
      // output beside the record of the step it started in.
      processes ??= [];
      const list = processes;
      const index = list.length;
      list.push(undefined);
      const dir = options.outputDir?.();
      return (entry, output) => {
        const kept = dir === undefined || output === undefined ? {} : keepOutput(dir, index + 1, output, options.secrets ?? []);
        list[index] = { ...entry, ...kept };
      };
    },
    snapshot(): ObservedCounts {
      const ran = processes?.filter((entry): entry is ProcessEntry => entry !== undefined) ?? null;
      return { processes: ran };
    },
    reset(): void {
      processes = null;
    },
  };
}

/** Writes each non-empty stream to its file and returns the entry fields
 * that name them. The file is created, never replaced: hooks of one
 * scenario share an evidence directory and each counts its processes from
 * 1, so a taken name moves to the next number. A stream that could not be
 * written is left out rather than failing the step: the program already
 * ran, and its exit code and files are still measured. */
function keepOutput(dir: string, position: number, output: ProcessOutput, secrets: SecretSet): { stdout?: string; stderr?: string } {
  const kept: { stdout?: string; stderr?: string } = {};
  for (const stream of ["stdout", "stderr"] as const) {
    if (output[stream] === "") continue;
    const text = redactString(output[stream], secrets);
    try {
      mkdirSync(dir, { recursive: true });
      for (let n = position; ; n += 1) {
        const name = processOutputFileName(n, stream);
        try {
          writeFileSync(path.join(dir, name), text, { flag: "wx" });
          kept[stream] = name;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } catch {
      // Left out, as the comment above says.
    }
  }
  return kept;
}
