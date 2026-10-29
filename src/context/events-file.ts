import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ownerOf, parseEventLine, type ParsedLine } from "../execution-events/format.js";
import { createTraceTally } from "../execution-events/tally.js";
import type { EventsSlice } from "../record/types.js";
import { redact, redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import type { StampedBoundaryTrace } from "./observed.js";
import { collectLate, createTraceFileReader, StepLines, type LateSlice, type TracedStep } from "./trace-slice.js";
import { traceIdIn } from "./trace-context.js";

// Responsibility: the execution events a world's program appends to the
// file `{events}` names (docs/execution-events.md, docs/spec.md "Execution
// events"): each step's slice of them, written beside its record when the
// step ends, and, once the world has stopped, the world's redacted copy
// and each step's lines that arrived after its record. Boundary: owns no
// file (the program writes it, src/program/world.ts makes and removes
// it), and decides nothing a line says (src/execution-events/ does).
// Reading forward, the wait, the cap, and the late pass are
// trace-slice.ts's, shared with the program's log.
//
// A line belongs to the step whose trace id its parsed `trace` field
// holds, never to one whose id merely appears in its text: a value inside
// an event can hold an id too. An unreadable line has no owner, so no
// step's events take data from it; when its text carries a step's trace
// id by the program log's rule, the step's slice counts it as damage to
// its trace, and the line is kept only in the world's copy.
//
// The program writes the file directly, not through a pipe nukadoko
// redacts, so the file stays in a directory of its own outside the run
// directory, and only redacted copies reach the run directory: each line
// is parsed, redacted with the step's secrets (trace ids kept), and
// written again as JSON, so a copy is JSON wherever a secret was, and a
// record shows exactly what was read. An unreadable line has no object to
// redact, so its text is redacted as the program log's is.
//
// The file nukadoko made is the one read. A file that is replaced, or
// made shorter, while the scenarios run (a writer that rotates it, or
// opens it to truncate) is no longer read, and every step from then on
// says so (`file-replaced`), since what it read may be incomplete.

/** A step's lines, beside its record. */
export const EVENTS_SLICE_FILE_NAME = "events.jsonl";

/** A step's lines that arrived after its record was written. */
export const EVENTS_LATE_FILE_NAME = "events-late.jsonl";

/** The world's redacted copy of the whole file, in the world's
 * directory. */
export const EVENTS_WORLD_FILE_NAME = "events.jsonl";

/** How many bytes of the world's copy the stop holds before appending. */
const COPY_FLUSH_BYTES = 4 * 1024 * 1024;

interface EventsLine {
  readonly text: string;
  readonly parsed: ParsedLine;
}

function readLine(text: string): EventsLine {
  return { text, parsed: parseEventLine(text) };
}

/** The line as a copy keeps it: the parsed object redacted and written
 * again, or the text redacted when there is no object (module header). */
function keptText(line: EventsLine, secrets: SecretSet): string {
  if (line.parsed.state === "unreadable") return redactString(line.text, secrets);
  try {
    return JSON.stringify(redact(line.parsed.object, secrets));
  } catch {
    // Two keys that redact to one: the text, redacted, loses neither.
    return redactString(line.text, secrets);
  }
}

function identityOf(filePath: string): { readonly dev: number; readonly ino: number; readonly size: number } | undefined {
  try {
    const stat = statSync(filePath);
    return { dev: stat.dev, ino: stat.ino, size: stat.size };
  } catch {
    return undefined;
  }
}

export interface EventsReader {
  /** Reads what the file gained since the last call and writes the slice
   * of `trace`'s boundary into `dir`. */
  slice(dir: string, trace: StampedBoundaryTrace): Promise<EventsSlice>;
}

/** A reader of the events file at `filePath` for the world whose trace
 * ids start with `prefix`, from the file's size now. */
export function createEventsReader(filePath: string, prefix: string, secrets: SecretSet): EventsReader {
  const made = identityOf(filePath);
  let replaced = made === undefined;
  const reader = createTraceFileReader(filePath, (offset) => {
    if (replaced) return false;
    const now = identityOf(filePath);
    replaced = now === undefined || now.dev !== made!.dev || now.ino !== made!.ino || now.size < offset;
    return !replaced;
  });
  return {
    async slice(dir, trace) {
      const tally = createTraceTally({ spans: trace.spans, spansNotKept: trace.spansNotKept, ranProcesses: trace.processes > 0 });
      const kept = new StepLines();
      let unowned = 0;
      await reader.readStep(trace.lastStampAt, (text) => {
        const line = readLine(text);
        const { parsed } = line;
        if (parsed.state === "unreadable") {
          if (traceIdIn(text, prefix) !== trace.traceId) return false;
          tally.damaged();
          return true;
        }
        const owner = ownerOf(parsed, prefix);
        if (owner === null) unowned += 1;
        if (owner !== trace.traceId) return false;
        tally.owned(parsed);
        kept.keep(keptText(line, secrets));
        return true;
      });
      const reading = tally.reading({ truncated: kept.budget.truncated, replaced });
      return {
        trace_id: trace.traceId,
        lines: reading.lines,
        file: kept.write(dir, EVENTS_SLICE_FILE_NAME),
        kinds: reading.kinds,
        stamped: trace.stamped,
        unreadable: reading.unreadable,
        unowned,
        whole: reading.whole,
        open: reading.open,
      };
    },
  };
}

/** What the world's stop counted over the whole file. */
export interface WorldEvents {
  /** Whether the world's copy was written whole. */
  readonly copied: boolean;
  readonly lines: number;
  readonly owned: number;
  readonly unowned: number;
  readonly unreadable: number;
  readonly undefinedKinds: Readonly<Record<string, number>>;
  /** Each step with a line after its slice, by trace id. */
  readonly late: ReadonlyMap<string, LateSlice>;
}

/** Reads the whole events file of a stopped world: writes its redacted
 * copy to `copyPath`, each step's lines past its slice to its
 * EVENTS_LATE_FILE_NAME, and counts what the file holds. `steps` give
 * `lines` as `observed.events.lines`. */
export function collectWorldEvents(filePath: string, prefix: string, steps: readonly TracedStep[], secrets: SecretSet, copyPath: string): WorldEvents {
  let lines = 0;
  let unowned = 0;
  let unreadable = 0;
  const undefinedKinds = new Map<string, number>();
  let pending: string[] = [];
  let pendingBytes = 0;
  let copied = true;
  const flush = (): void => {
    if (pending.length === 0) return;
    try {
      appendFileSync(copyPath, `${pending.join("\n")}\n`);
    } catch {
      copied = false;
    }
    pending = [];
    pendingBytes = 0;
  };
  withoutChannelRecording(() => {
    try {
      mkdirSync(path.dirname(copyPath), { recursive: true });
      writeFileSync(copyPath, "");
    } catch {
      copied = false;
    }
  });
  const { owned, late } = collectLate(filePath, steps, {
    read: readLine,
    ownerOf: (line) => ownerOf(line.parsed, prefix) ?? undefined,
    keep: (line) => keptText(line, secrets),
    fileName: EVENTS_LATE_FILE_NAME,
    onLine(line, owner) {
      lines += 1;
      const { parsed } = line;
      if (parsed.state === "unreadable") unreadable += 1;
      else if (owner === undefined) unowned += 1;
      if (parsed.state === "undefined-kind") undefinedKinds.set(parsed.kind, (undefinedKinds.get(parsed.kind) ?? 0) + 1);
      if (!copied) return;
      const text = keptText(line, secrets);
      pending.push(text);
      pendingBytes += text.length;
      if (pendingBytes > COPY_FLUSH_BYTES) flush();
    },
  });
  withoutChannelRecording(flush);
  return { copied, lines, owned, unowned, unreadable, undefinedKinds: Object.fromEntries(undefinedKinds), late };
}
