import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withoutChannelRecording } from "./channels.js";
import { completeLines } from "./trace-context.js";

// Responsibility: a file of lines a world's program fills while the
// scenarios run, read forward per step, with the lines of each step kept
// beside its record, and, once the world has stopped, the lines of each
// step that came after its record. The program's log and its execution
// events are two such files (program-log-slice.ts, events-file.ts); the
// forward read, the wait for a step's lines still on their way, the cap
// on what one step's file holds, and the late pass exist once, here.
// Boundary: which step a line belongs to and what of it is kept are the
// caller's; this module reads, waits, and writes the files it is handed.
//
// A step's process reads the file forward from where it stood when the
// reader was made, since no line before that can carry an id the reader's
// context makes. A program writes a step's line around the time it
// answers, and the line can reach the file after the step's code has read
// the answer. So a step that stamped a request reads the file as it waits,
// until no line of its own has arrived for QUIET_MS after the later of
// its last such line and the moment the step ended, and no longer than
// SETTLE_MS in all. Only the step's own lines count: a file that other
// work keeps busy (a hook, a background job, another worker's step) would
// otherwise make every stamped step wait the whole SETTLE_MS. The quiet
// counts from the step's end, not from the request: a request that took
// longer than QUIET_MS to answer would otherwise leave no wait at all for
// the line the program wrote as it answered. A step that stamped nothing
// does not wait.
//
// A line that arrives after that is still the step's. Its record is
// already written and is not rewritten, so when the world stops, one pass
// over the whole file counts each step's lines again: the slice held the
// first `lines` of them, read in the order the file holds them, and every
// one after those goes to the step's late file. The slice can skip none of
// its own lines: a step's trace id is made when its boundary opens, after
// the step before it read the file, so no line before where that read
// stopped can carry it.
//
// Every read and write here runs inside `withoutChannelRecording`: these
// are nukadoko's own files, never a step's.

const QUIET_MS = 30;
const SETTLE_MS = 300;
const POLL_MS = 10;

/** The most one of a step's files holds. A step whose lines come to more
 * keeps the first of them, marked `truncated`, and its count says how
 * many there were. */
export const SLICE_CAP_BYTES = 16 * 1024 * 1024;

/** How much of the file one read takes, so a long file is never read
 * whole into memory. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** How many late lines the world's stop holds before it appends them to
 * their files. */
const LATE_FLUSH_BYTES = 4 * 1024 * 1024;

function sizeOf(filePath: string): number | undefined {
  try {
    return statSync(filePath).size;
  } catch {
    // No line written yet.
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hands each complete line of `filePath` from byte `from` to its end to
 * `onLine`, with the byte the line starts at, a chunk at a time, and
 * returns the byte after the last complete line: a line still being
 * written is read by the next call. A file that does not exist yet has no
 * lines. */
export function forEachLogLine(filePath: string, from: number, onLine: (line: string, at: number) => void): number {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
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
      // Each line starts after the line feed before it: decoding never
      // makes or removes one, so the lines and the line feeds pair up.
      let start = 0;
      for (const line of lines) {
        onLine(line, offset + start);
        start = bytes.indexOf(0x0a, start) + 1;
      }
      offset += consumed;
      carry = bytes.subarray(consumed);
    }
  } finally {
    closeSync(fd);
  }
}

/** What one file may still hold, out of SLICE_CAP_BYTES. */
export class FileBudget {
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

/** The lines one step keeps, within the cap. */
export class StepLines {
  readonly budget = new FileBudget();
  readonly kept: string[] = [];

  keep(text: string): void {
    if (this.budget.take(text)) this.kept.push(text);
  }

  /** Writes the kept lines to `name` in `dir` and returns `name`, or
   * `null` when none were kept or the file could not be written: the
   * count in the record still says how many lines the step had. */
  write(dir: string, name: string): string | null {
    if (this.kept.length === 0) return null;
    let file: string | null = null;
    withoutChannelRecording(() => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, name), `${this.kept.join("\n")}\n`);
        file = name;
      } catch {
        // Left out (above).
      }
    });
    return file;
  }
}

export interface TraceFileReader {
  /** Reads what the file gained since the last call and hands each
   * complete line to `own`, which answers whether the line is the ending
   * step's; then, when the step stamped a request (`lastStampAt`), keeps
   * reading as it waits for the step's lines still on their way (module
   * header). */
  readStep(lastStampAt: number | undefined, own: (line: string) => boolean): Promise<void>;
  /** The byte the next read starts at: no line before it can carry a
   * trace id made after the last read. */
  offset(): number;
}

/** A reader of `filePath` from the file's size now. `readable`, asked
 * before each read with the byte the read starts at, stops the reads
 * once it answers false: a file that is no longer the one nukadoko made
 * has nothing more to say about the steps. */
export function createTraceFileReader(filePath: string, readable: (offset: number) => boolean = () => true): TraceFileReader {
  let offset = sizeOf(filePath) ?? 0;
  return {
    offset: () => offset,
    async readStep(lastStampAt, own) {
      let lastOwnLineAt: number | undefined;
      const read = (): void => {
        try {
          withoutChannelRecording(() => {
            if (!readable(offset)) return;
            offset = forEachLogLine(filePath, offset, (line) => {
              if (own(line)) lastOwnLineAt = Date.now();
            });
          });
        } catch {
          // A file that cannot be read gives no lines; the parent still has it.
        }
      };
      read();
      if (lastStampAt === undefined) return;
      const ended = Date.now();
      const deadline = ended + SETTLE_MS;
      for (;;) {
        const quietSince = Math.max(ended, lastOwnLineAt ?? 0);
        const now = Date.now();
        if (now - quietSince >= QUIET_MS || now >= deadline) break;
        await sleep(Math.min(POLL_MS, deadline - now));
        read();
      }
    },
  };
}

/** A step the world's stop looks for late lines of. */
export interface TracedStep {
  readonly traceId: string;
  /** How many of its lines its slice read. */
  readonly lines: number;
  /** The step record's directory, absolute. */
  readonly dir: string;
}

/** A step's lines that arrived after its record was written. */
export interface LateSlice {
  readonly lines: number;
  /** The late file's name, or `null` when it could not be written. */
  readonly file: string | null;
  readonly truncated?: true;
}

/** How the world's stop reads one kind of file. */
export interface LateReading<Line> {
  /** What one line is. */
  read(text: string): Line;
  /** The step trace id the line carries, or `undefined`. */
  ownerOf(line: Line): string | undefined;
  /** The text a step's late file keeps of the line, redacted. */
  keep(line: Line): string;
  /** The late file's name beside each step record. */
  readonly fileName: string;
  /** Every line of the file, in order, with its owner. */
  onLine?(line: Line, owner: string | undefined): void;
}

/** Reads the whole file of a stopped world, counts the lines that carry
 * a trace id of it (`owned`), and writes each step's lines past its slice
 * to its late file (module header). */
export function collectLate<Line>(
  filePath: string,
  steps: readonly TracedStep[],
  reading: LateReading<Line>,
): { readonly owned: number; readonly late: ReadonlyMap<string, LateSlice> } {
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
        appendFileSync(path.join(entry.step.dir, reading.fileName), `${entry.pending.join("\n")}\n`);
      } catch {
        entry.failed = true;
      }
      entry.pending = [];
    }
    pendingBytes = 0;
  };
  let owned = 0;
  withoutChannelRecording(() => {
    try {
      forEachLogLine(filePath, 0, (text) => {
        const line = reading.read(text);
        const id = reading.ownerOf(line);
        reading.onLine?.(line, id);
        if (id === undefined) return;
        owned += 1;
        const entry = entries.get(id);
        if (entry === undefined) return;
        entry.seen += 1;
        if (entry.seen <= entry.step.lines) return;
        entry.late += 1;
        const kept = reading.keep(line);
        if (!entry.budget.take(kept)) return;
        entry.pending.push(kept);
        pendingBytes += kept.length;
        if (pendingBytes > LATE_FLUSH_BYTES) flush();
      });
    } catch {
      // A file that cannot be read gives no late lines.
    }
    flush();
  });
  const late = new Map<string, LateSlice>();
  for (const [traceId, entry] of entries) {
    if (entry.late === 0) continue;
    late.set(traceId, {
      lines: entry.late,
      file: entry.failed || entry.budget.bytes === 0 ? null : reading.fileName,
      ...(entry.budget.truncated ? { truncated: true as const } : {}),
    });
  }
  return { owned, late };
}
