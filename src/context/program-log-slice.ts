import type { ProgramLogSlice } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import type { BoundaryTrace } from "./observed.js";
import { collectLate, createTraceFileReader, StepLines, type LateSlice, type TracedStep } from "./trace-slice.js";
import { traceIdIn } from "./trace-context.js";

export { forEachLogLine, SLICE_CAP_BYTES, type LateSlice, type TracedStep } from "./trace-slice.js";

// Responsibility: the lines of a world's `program.log` that belong to a
// step (docs/spec.md "Trace context and the program's log"): the step's
// slice, written beside its record when the step ends, and, once the world
// has stopped, the lines of each step that arrived after its slice was
// written. Boundary: which lines are the step's and what the record keeps
// of them. Reading the log forward, the wait for a step's lines still on
// their way, the cap, and the late pass are trace-slice.ts's; which trace
// id a line carries is trace-context.ts's; each boundary's trace id is
// observed.ts's; and the parent process writes the log
// (src/program/program-log.ts), whole lines only, as they arrive.
//
// A line belongs to the step whose trace id it carries, wherever it is in
// the log: the first place in the line where the world's prefix begins 32
// hexadecimal characters. Under `--concurrency` the parent writes the log
// and each worker reads it, and each worker keeps only its own steps'
// lines. The log is redacted as the parent writes it; a step's own
// secrets are redacted again here, since the slice is a file of the
// step's record.

/** The slice's file, beside the step record. */
export const PROGRAM_LOG_SLICE_FILE_NAME = "program-log.txt";

/** The file beside the step record for the step's lines that arrived
 * after its record was written. */
export const PROGRAM_LOG_LATE_FILE_NAME = "program-log-late.txt";

export interface ProgramLogReader {
  /** Reads what the log gained since the last call and writes the slice
   * of `trace`'s boundary into `dir`. */
  slice(dir: string, trace: BoundaryTrace): Promise<ProgramLogSlice>;
}

/** A reader of the log at `logPath` for the world whose trace ids start
 * with `prefix`, from the log's size now. */
export function createProgramLogReader(logPath: string, prefix: string, secrets: SecretSet): ProgramLogReader {
  const reader = createTraceFileReader(logPath);
  return {
    async slice(dir: string, trace: BoundaryTrace): Promise<ProgramLogSlice> {
      const kept = new StepLines();
      let lines = 0;
      await reader.readStep(trace.lastStampAt, (line) => {
        if (traceIdIn(line, prefix) !== trace.traceId) return false;
        lines += 1;
        kept.keep(redactString(line, secrets));
        return true;
      });
      const file = kept.write(dir, PROGRAM_LOG_SLICE_FILE_NAME);
      return { trace_id: trace.traceId, lines, file, stamped: trace.stamped, ...(kept.budget.truncated ? { truncated: true as const } : {}) };
    },
  };
}

export interface LateLines {
  /** How many lines of the log carry a trace id of the world, a hook's
   * included. */
  readonly tagged: number;
  /** Each step with a line after its slice, by trace id. */
  readonly late: ReadonlyMap<string, LateSlice>;
}

/** Reads the whole log of a stopped world, counts the lines that carry a
 * trace id of it, and writes each step's lines past its slice to its
 * PROGRAM_LOG_LATE_FILE_NAME, redacted. */
export function collectLateLines(logPath: string, prefix: string, steps: readonly TracedStep[], secrets: SecretSet): LateLines {
  const { owned, late } = collectLate(logPath, steps, {
    read: (text) => text,
    ownerOf: (line) => traceIdIn(line, prefix),
    keep: (line) => redactString(line, secrets),
    fileName: PROGRAM_LOG_LATE_FILE_NAME,
  });
  return { tagged: owned, late };
}
