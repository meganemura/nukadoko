import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProgramLogSlice } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import type { BoundaryTrace } from "./observed.js";
import { completeLines, sliceProgramLog } from "./trace-context.js";

// Responsibility: a step's slice of the world's `program.log` (docs/spec.md
// "Trace context and the program's log"): the lines the program wrote while the step ran that carry
// the step's span id, or the scenario's trace id and no other boundary's
// span id, written beside the step record. Boundary: reading the log and
// writing the slice. Which lines belong to a step is trace-context.ts's,
// the ids are observed.ts's, and the parent process writes the log
// (src/program/program-log.ts), whole lines only, as they arrive.
//
// A step's window starts at the log's size when the step began, so each
// step reads only what the program wrote while it ran, however long the
// log grows over a run. Under `--concurrency` the parent writes the log
// and each worker reads it; the trace id keeps one scenario's lines apart
// from another's that the program wrote at the same time.
//
// A program writes its line for a request around the time it answers,
// and the line reaches the log through a pipe and the parent's line
// buffer, which can be after the step's code has read the answer. So a
// step that stamped a request waits until the log has been quiet for
// QUIET_MS after the later of its last write and the step's last stamped
// request, and no longer than SETTLE_MS in all. A step that stamped
// nothing does not wait: no line can carry its ids.

/** The slice's file, beside the step record. */
export const PROGRAM_LOG_SLICE_FILE_NAME = "program-log.txt";

const QUIET_MS = 30;
const SETTLE_MS = 300;
const POLL_MS = 10;

/** The most one step's window reads of the log. A step that makes the
 * program write more than this gets the slice of the first part, marked
 * `truncated`. */
export const WINDOW_CAP_BYTES = 16 * 1024 * 1024;

export interface ProgramLogReader {
  /** Starts a boundary's window at the log's size now. */
  begin(): void;
  /** Reads the current window and writes the slice of `trace`'s step into
   * `dir`. */
  slice(dir: string, trace: BoundaryTrace | undefined): Promise<ProgramLogSlice>;
}

function stat(logPath: string): { readonly size: number; readonly mtimeMs: number } | undefined {
  try {
    const { size, mtimeMs } = statSync(logPath);
    return { size, mtimeMs };
  } catch {
    // No line written yet.
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for the log to be quiet after `lastStampAt` (module header). */
async function settle(logPath: string, lastStampAt: number): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const quietSince = Math.max(lastStampAt, stat(logPath)?.mtimeMs ?? 0);
    const now = Date.now();
    if (now - quietSince >= QUIET_MS || now >= deadline) return;
    await sleep(Math.min(POLL_MS, deadline - now));
  }
}

/** The text from byte `start` to the end of the log, at most
 * WINDOW_CAP_BYTES of it. */
function readWindow(logPath: string, start: number): { readonly text: string; readonly truncated: boolean } {
  const size = stat(logPath)?.size ?? 0;
  if (size <= start) return { text: "", truncated: false };
  const length = Math.min(size - start, WINDOW_CAP_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  try {
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), truncated: size - start > WINDOW_CAP_BYTES };
  } finally {
    closeSync(fd);
  }
}

export function createProgramLogReader(logPath: string, secrets: SecretSet): ProgramLogReader {
  let start = 0;
  return {
    begin(): void {
      start = stat(logPath)?.size ?? 0;
    },
    async slice(dir: string, trace: BoundaryTrace | undefined): Promise<ProgramLogSlice> {
      if (trace === undefined) return { lines: 0, file: null, stamped: 0 };
      if (trace.lastStampAt !== undefined) await settle(logPath, trace.lastStampAt);
      let window: { readonly text: string; readonly truncated: boolean };
      try {
        window = withoutChannelRecording(() => readWindow(logPath, start));
      } catch {
        // A log that cannot be read gives no lines; the parent still has it.
        window = { text: "", truncated: false };
      }
      // The log is redacted as the parent writes it; the step's own
      // secrets are redacted again here, since the slice is a file of the
      // step's record.
      const lines = sliceProgramLog(completeLines(window.text), trace).map((line) => redactString(line, secrets));
      let file: string | null = null;
      if (lines.length > 0) {
        withoutChannelRecording(() => {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, PROGRAM_LOG_SLICE_FILE_NAME), `${lines.join("\n")}\n`);
            file = PROGRAM_LOG_SLICE_FILE_NAME;
          } catch {
            // Left out: the count still says how many lines the step had.
          }
        });
      }
      return { lines: lines.length, file, stamped: trace.stamped, ...(window.truncated ? { truncated: true as const } : {}) };
    },
  };
}
