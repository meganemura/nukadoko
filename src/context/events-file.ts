import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ownerOf, parseEventLine, type ParsedLine } from "../execution-events/format.js";
import type { CountedGroup } from "../execution-events/counted.js";
import { createPathFold, type PathFold, type StepPath } from "../execution-events/path.js";
import type { EventSelection } from "../execution-events/selection.js";
import { createKindsSeen, createTraceTally, readingGaps, type EventsGap, type KindsSeen, type SelectionCount, type TallyInputs, type TraceTally } from "../execution-events/tally.js";
import type { EventsSlice } from "../record/types.js";
import { redact, redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import type { StampedBoundaryTrace } from "./observed.js";
import { collectLate, createTraceFileReader, forEachLogLine, StepLines, type LateSlice, type TracedStep } from "./trace-slice.js";
import { traceIdIn } from "./trace-context.js";

// Responsibility: the execution events a world's program appends to the
// file `{events}` names (docs/execution-events.md, docs/spec.md "Execution
// events"): each step's slice of them, written beside its record when the
// step ends, and, once the world has stopped, the world's redacted copy,
// each step's lines that arrived after its record, each step's coarse
// path (src/execution-events/path.ts: the flags it evaluated and the
// requests it sent among them), read in that one pass so a late line
// counts as one in the slice does, and each count a claim step took of a
// step's lines, taken again over all of them. Boundary: owns no file (the
// program writes it, src/program/world.ts makes and removes it), and
// decides nothing a line says (src/execution-events/ does).
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
export function keptLine(text: string, parsed: ParsedLine, secrets: SecretSet): string {
  if (parsed.state === "unreadable") return redactString(text, secrets);
  try {
    return JSON.stringify(redact(parsed.object, secrets));
  } catch {
    // Two keys that redact to one: the text, redacted, loses neither.
    return redactString(text, secrets);
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

/** The world's events file, as a claim step's reading reads it
 * (events-read.ts). */
export interface WorldEventsFile {
  readonly path: string;
  /** The eight characters every trace id of the world starts with. */
  readonly prefix: string;
  /** Whether the file is still the one nukadoko made, asked before each
   * read from `offset`: once it answers false, it always does. */
  readable(offset: number): boolean;
  /** The kinds the world's program has reported, through the end of the
   * file as it stands now. */
  kindsSeen(): KindsSeen;
}

/** Where a step's events start in the world's file, and what its trace
 * needs to be told whole: what a later step's reading of them starts
 * from. */
export interface ProducerStart {
  readonly traceId: string;
  /** The byte the step's slice began reading at. No line before it can
   * carry the step's trace id (trace-slice.ts). */
  readonly from: number;
  readonly inputs: Omit<TallyInputs, "selections">;
}

export interface EventsReader {
  /** Reads what the file gained since the last call and writes the slice
   * of `trace`'s boundary into `dir`. */
  slice(dir: string, trace: StampedBoundaryTrace): Promise<EventsSlice>;
  /** Where the step whose trace is `traceId` began, `undefined` when this
   * reader sliced no such step. */
  producer(traceId: string): ProducerStart | undefined;
  readonly world: WorldEventsFile;
}

/** What a tally needs of a boundary's trace. */
export function tallyInputsOf(trace: StampedBoundaryTrace): Omit<TallyInputs, "selections"> {
  return { spans: trace.spans, spansNotKept: trace.spansNotKept, ranProcesses: trace.processes > 0, processSpans: trace.processSpans };
}

/** A reader of the events file at `filePath` for the world whose trace
 * ids start with `prefix`, from the file's size now. */
export function createEventsReader(filePath: string, prefix: string, secrets: SecretSet): EventsReader {
  const made = identityOf(filePath);
  let replaced = made === undefined;
  const readable = (offset: number): boolean => {
    if (replaced) return false;
    const now = identityOf(filePath);
    replaced = now === undefined || now.dev !== made!.dev || now.ino !== made!.ino || now.size < offset;
    return !replaced;
  };
  const reader = createTraceFileReader(filePath, readable);
  const producers = new Map<string, ProducerStart>();
  // The world's kinds, read forward from the file's start the first time
  // a reading asks: earlier scenarios' lines say what the program reports.
  const kinds = createKindsSeen();
  let kindsRead = 0;
  return {
    world: {
      path: filePath,
      prefix,
      readable,
      kindsSeen() {
        withoutChannelRecording(() => {
          try {
            if (readable(kindsRead)) kindsRead = forEachLogLine(filePath, kindsRead, (text) => kinds.note(parseEventLine(text)));
          } catch {
            // A file that cannot be read reports no kind.
          }
        });
        return kinds;
      },
    },
    producer: (traceId) => producers.get(traceId),
    async slice(dir, trace) {
      const inputs = tallyInputsOf(trace);
      producers.set(trace.traceId, { traceId: trace.traceId, from: reader.offset(), inputs });
      const tally = createTraceTally(inputs);
      const kept = new StepLines();
      await reader.readStep(trace.lastStampAt, (text) => {
        const line = readLine(text);
        const { parsed } = line;
        if (parsed.state === "unreadable") {
          if (traceIdIn(text, prefix) !== trace.traceId) return false;
          tally.damaged();
          return true;
        }
        const owner = ownerOf(parsed, prefix);
        if (owner === null) tally.unowned(parsed);
        if (owner !== trace.traceId) return false;
        tally.owned(parsed);
        kept.keep(keptLine(text, parsed, secrets));
        return true;
      });
      const reading = tally.reading({ truncated: kept.budget.truncated, replaced });
      return {
        trace_id: trace.traceId,
        lines: reading.lines,
        file: kept.write(dir, EVENTS_SLICE_FILE_NAME),
        kinds: reading.kinds,
        stamped: trace.stamped,
        stamped_spans: trace.spans,
        unreadable: reading.unreadable,
        unowned: reading.unowned,
        process_spans: trace.processSpans,
        process_requests: reading.processRequests,
        whole: reading.whole,
        open: reading.open,
      };
    },
  };
}

/** A claim step's reading of a count, which the world's stop counts again
 * over every line of the producer's trace (src/run/events-after-stop.ts). */
export interface Recount {
  readonly traceId: string;
  readonly inputs: Omit<TallyInputs, "selections">;
  readonly selection: EventSelection;
  /** The reading found the file replaced or made shorter: the file the
   * stop reads is not the one the reading read, so the count stays
   * open. */
  readonly replaced: boolean;
}

/** A step of the stopped world whose slice read the file. */
export interface EventsStep extends TracedStep {
  /** What its trace needs to be told whole. */
  readonly inputs: Omit<TallyInputs, "selections">;
  /** Its slice found the file replaced or made shorter: the file the
   * stop reads is not the one the slice read. */
  readonly replaced: boolean;
}

/** That count, over every line of the file. The lines no step owns are
 * not counted: they belong to the reading's window, which closed when it
 * read. */
export interface Recounted {
  /** Readable lines of the trace, all of them. */
  readonly lines: number;
  readonly unreadable: number;
  readonly count: SelectionCount;
  /** What keeps the count from being whole, with the kinds the world's
   * program reported through the end of the file. */
  readonly open: readonly EventsGap[];
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
  /** Each step's coarse path, by trace id, from every line of its trace
   * the file holds: its slice and its late lines alike. */
  readonly paths: ReadonlyMap<string, StepPath>;
  /** One per recount the stop was given, in order. */
  readonly recounted: readonly Recounted[];
}

/** Reads the whole events file of a stopped world: writes its redacted
 * copy to `copyPath`, each step's lines past its slice to its
 * EVENTS_LATE_FILE_NAME, counts what the file holds, folds each step's
 * path, and counts each of `recounts` again over every line of its
 * trace. `steps` give `lines` as `observed.events.lines`. */
export function collectWorldEvents(
  filePath: string,
  prefix: string,
  steps: readonly EventsStep[],
  secrets: SecretSet,
  copyPath: string,
  recounts: readonly Recount[] = [],
): WorldEvents {
  let lines = 0;
  let unowned = 0;
  let unreadable = 0;
  const undefinedKinds = new Map<string, number>();
  const folds = new Map<string, PathFold>(steps.map((step) => [step.traceId, createPathFold(step.inputs)]));
  const kinds = createKindsSeen();
  const tallies = recounts.map((recount) => createTraceTally({ ...recount.inputs, selections: [recount.selection] }));
  const talliesOf = new Map<string, TraceTally[]>();
  recounts.forEach((recount, index) => talliesOf.set(recount.traceId, [...(talliesOf.get(recount.traceId) ?? []), tallies[index]!]));
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
    keep: (line) => keptLine(line.text, line.parsed, secrets),
    fileName: EVENTS_LATE_FILE_NAME,
    onLine(line, owner) {
      lines += 1;
      const { parsed } = line;
      if (parsed.state === "unreadable") unreadable += 1;
      else if (owner === undefined) unowned += 1;
      if (parsed.state === "undefined-kind") undefinedKinds.set(parsed.kind, (undefinedKinds.get(parsed.kind) ?? 0) + 1);
      kinds.note(parsed);
      // Ownership as the slice reads it (module header): a damaged line by
      // the id its text carries, a readable one by its `trace` field.
      if (parsed.state === "unreadable") {
        const id = traceIdIn(line.text, prefix);
        if (id !== undefined) {
          folds.get(id)?.damaged();
          for (const tally of talliesOf.get(id) ?? []) tally.damaged();
        }
      } else if (owner !== undefined) {
        folds.get(owner)?.owned(parsed);
        for (const tally of talliesOf.get(owner) ?? []) tally.owned(parsed);
      }
      if (!copied) return;
      const text = keptLine(line.text, parsed, secrets);
      pending.push(text);
      pendingBytes += text.length;
      if (pendingBytes > COPY_FLUSH_BYTES) flush();
    },
  });
  withoutChannelRecording(flush);
  // Nothing is kept, so nothing is cut.
  const paths = new Map(steps.map((step) => [step.traceId, folds.get(step.traceId)!.path({ truncated: false, replaced: step.replaced })]));
  const recounted = recounts.map((recount, index): Recounted => {
    // Nothing is kept, so nothing is cut.
    const reading = tallies[index]!.reading({ truncated: false, replaced: recount.replaced });
    // The groups name what lines hold, so they are redacted as the
    // reading's record is, and the two compare alike.
    const count = { ...reading.counts[0]!, counted: redact(reading.counts[0]!.counted, secrets) as CountedGroup[] };
    return { lines: reading.lines, unreadable: reading.unreadable, count, open: readingGaps(reading.open, recount.selection.kind, kinds) };
  });
  return { copied, lines, owned, unowned, unreadable, undefinedKinds: Object.fromEntries(undefinedKinds), late, paths, recounted };
}
