import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProgramLogSlice } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import type { BoundaryTrace } from "./observed.js";
import { completeLines, traceIdIn } from "./trace-context.js";

// Responsibility: the lines of a world's `program.log` that belong to a
// step (docs/spec.md "Trace context and the program's log"): the step's
// slice, written beside its record when the step ends, and, once the world
// has stopped, the lines of each step that arrived after its slice was
// written. Boundary: reading the log and writing those two files. Which
// trace id a line carries is trace-context.ts's, each boundary's trace id
// is observed.ts's, and the parent process writes the log
// (src/program/program-log.ts), whole lines only, as they arrive.
//
// A line belongs to the step whose trace id it carries, wherever it is in
// the log. A step's process reads the log forward from where it stood when
// the step's context was created, since no line before that can carry an
// id the context makes, and keeps the lines that carry the ending step's
// id. Under `--concurrency` the parent writes the log and each worker
// reads it, and each worker keeps only its own steps' lines.
//
// A program writes its line for a request around the time it answers,
// and the line reaches the log through a pipe and the parent's line
// buffer, which can be after the step's code has read the answer. So a
// step that stamped a request reads the log as it waits, until no line
// carrying its own trace id has arrived for QUIET_MS after the later of
// the last such line and the moment the step ended, and no longer than
// SETTLE_MS in all. Only the step's own lines count: a log that other work
// keeps busy (a hook, a background job, another worker's step) would
// otherwise make every stamped step wait the whole SETTLE_MS. The quiet
// counts from the step's end, not from the request: a request that took
// longer than QUIET_MS to answer would otherwise leave no wait at all for
// the line the program wrote as it answered. A step that stamped nothing
// does not wait.
//
// A line that arrives after that is still the step's. The step's record
// is already written and is not rewritten, so when the world stops, one
// pass over the whole log counts each step's lines again: the slice held
// the first `lines` of them, read in the order the log holds them, and
// every one after those goes to the step's PROGRAM_LOG_LATE_FILE_NAME. The
// slice can skip none of its own lines: a step's trace id is made when its
// boundary opens, after the step before it read the log, so no line before
// where that read stopped can carry it.

/** The slice's file, beside the step record. */
export const PROGRAM_LOG_SLICE_FILE_NAME = "program-log.txt";

/** The file beside the step record for the step's lines that arrived
 * after its record was written. */
export const PROGRAM_LOG_LATE_FILE_NAME = "program-log-late.txt";

const QUIET_MS = 30;
const SETTLE_MS = 300;
const POLL_MS = 10;

/** The most one of a step's files holds. A step whose lines come to more
 * keeps the first of them, marked `truncated`, and its count says how
 * many there were. */
export const SLICE_CAP_BYTES = 16 * 1024 * 1024;

/** How much of the log one read takes, so a long log is never read whole
 * into memory. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** How many late lines the world's stop holds before it appends them to
 * their files. */
const LATE_FLUSH_BYTES = 4 * 1024 * 1024;

function sizeOf(logPath: string): number | undefined {
  try {
    return statSync(logPath).size;
  } catch {
    // No line written yet.
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hands each complete line of `logPath` from byte `from` to its end to
 * `onLine`, a chunk at a time, and returns the byte after the last
 * complete line: a line still being written is read by the next call. A
 * log that does not exist yet has no lines. */
export function forEachLogLine(logPath: string, from: number, onLine: (line: string) => void): number {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return from;
  }
  try {
    let offset = from;
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const count = readSync(fd, chunk, 0, READ_CHUNK_BYTES, offset + carry.length);
      if (count === 0) return offset;
      const bytes = carry.length === 0 ? chunk.subarray(0, count) : Buffer.concat([carry, chunk.subarray(0, count)]);
      const { lines, consumed } = completeLines(bytes);
      for (const line of lines) onLine(line);
      offset += consumed;
      carry = bytes.subarray(consumed);
    }
  } finally {
    closeSync(fd);
  }
}

/** What one file may still hold, out of SLICE_CAP_BYTES. */
class FileBudget {
  bytes = 0;
  truncated = false;

  /** Whether `line` fits; once one does not, no later line does. */
  take(line: string): boolean {
    const size = Buffer.byteLength(line) + 1;
    if (this.truncated || this.bytes + size > SLICE_CAP_BYTES) {
      this.truncated = true;
      return false;
    }
    this.bytes += size;
    return true;
  }
}

export interface ProgramLogReader {
  /** Reads what the log gained since the last call and writes the slice
   * of `trace`'s boundary into `dir`. */
  slice(dir: string, trace: BoundaryTrace): Promise<ProgramLogSlice>;
}

/** A reader of the log at `logPath` for the world whose trace ids start
 * with `prefix`, from the log's size now. */
export function createProgramLogReader(logPath: string, prefix: string, secrets: SecretSet): ProgramLogReader {
  let offset = sizeOf(logPath) ?? 0;
  return {
    async slice(dir: string, trace: BoundaryTrace): Promise<ProgramLogSlice> {
      const budget = new FileBudget();
      const kept: string[] = [];
      let lines = 0;
      let lastOwnLineAt: number | undefined;
      const read = (): void => {
        try {
          offset = withoutChannelRecording(() =>
            forEachLogLine(logPath, offset, (line) => {
              if (traceIdIn(line, prefix) !== trace.traceId) return;
              lines += 1;
              lastOwnLineAt = Date.now();
              // The log is redacted as the parent writes it; the step's own
              // secrets are redacted again here, since the slice is a file
              // of the step's record.
              const redacted = redactString(line, secrets);
              if (budget.take(redacted)) kept.push(redacted);
            }),
          );
        } catch {
          // A log that cannot be read gives no lines; the parent still has it.
        }
      };
      read();
      // The wait for the step's own lines still on their way (module header).
      if (trace.lastStampAt !== undefined) {
        const ended = Date.now();
        const deadline = ended + SETTLE_MS;
        for (;;) {
          const quietSince = Math.max(ended, lastOwnLineAt ?? 0);
          const now = Date.now();
          if (now - quietSince >= QUIET_MS || now >= deadline) break;
          await sleep(Math.min(POLL_MS, deadline - now));
          read();
        }
      }
      let file: string | null = null;
      if (kept.length > 0) {
        withoutChannelRecording(() => {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, PROGRAM_LOG_SLICE_FILE_NAME), `${kept.join("\n")}\n`);
            file = PROGRAM_LOG_SLICE_FILE_NAME;
          } catch {
            // Left out: the count still says how many lines the step had.
          }
        });
      }
      return { trace_id: trace.traceId, lines, file, stamped: trace.stamped, ...(budget.truncated ? { truncated: true as const } : {}) };
    },
  };
}

/** A step the world's stop looks for late lines of. */
export interface TracedStep {
  readonly traceId: string;
  /** How many of its lines its slice read: `observed.program_log.lines`. */
  readonly lines: number;
  /** The step record's directory, absolute. */
  readonly dir: string;
}

/** A step's lines that arrived after its record was written. */
export interface LateSlice {
  readonly lines: number;
  /** PROGRAM_LOG_LATE_FILE_NAME, or `null` when it could not be written. */
  readonly file: string | null;
  readonly truncated?: true;
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
 * PROGRAM_LOG_LATE_FILE_NAME, redacted (module header). */
export function collectLateLines(logPath: string, prefix: string, steps: readonly TracedStep[], secrets: SecretSet): LateLines {
  interface Entry {
    readonly step: TracedStep;
    seen: number;
    late: number;
    readonly budget: FileBudget;
    pending: string[];
    failed: boolean;
  }
  const entries = new Map<string, Entry>();
  for (const step of steps) entries.set(step.traceId, { step, seen: 0, late: 0, budget: new FileBudget(), pending: [], failed: false });
  let pendingBytes = 0;
  const flush = (): void => {
    for (const entry of entries.values()) {
      if (entry.pending.length === 0) continue;
      try {
        mkdirSync(entry.step.dir, { recursive: true });
        appendFileSync(path.join(entry.step.dir, PROGRAM_LOG_LATE_FILE_NAME), `${entry.pending.join("\n")}\n`);
      } catch {
        entry.failed = true;
      }
      entry.pending = [];
    }
    pendingBytes = 0;
  };
  let tagged = 0;
  withoutChannelRecording(() => {
    try {
      forEachLogLine(logPath, 0, (line) => {
        const id = traceIdIn(line, prefix);
        if (id === undefined) return;
        tagged += 1;
        const entry = entries.get(id);
        if (entry === undefined) return;
        entry.seen += 1;
        if (entry.seen <= entry.step.lines) return;
        entry.late += 1;
        const text = redactString(line, secrets);
        if (!entry.budget.take(text)) return;
        entry.pending.push(text);
        pendingBytes += text.length;
        if (pendingBytes > LATE_FLUSH_BYTES) flush();
      });
    } catch {
      // A log that cannot be read gives no late lines.
    }
    flush();
  });
  const late = new Map<string, LateSlice>();
  for (const [traceId, entry] of entries) {
    if (entry.late === 0) continue;
    late.set(traceId, {
      lines: entry.late,
      file: entry.failed || entry.budget.bytes === 0 ? null : PROGRAM_LOG_LATE_FILE_NAME,
      ...(entry.budget.truncated ? { truncated: true as const } : {}),
    });
  }
  return { tagged, late };
}
