import path from "node:path";
import { rangeOf } from "../execution-events/count.js";
import { ownerOf, parseEventLine, type EventKindName, type ParsedLine } from "../execution-events/format.js";
import { matchLine, type EventSelection } from "../execution-events/selection.js";
import { createKindsSeen, createTraceTally, GAP_WORDS, type EventsGap, type KindsSeen, type MaybeCounts, type TallyInputs, type TraceTally } from "../execution-events/tally.js";
import type { EventsProducerRecord, EventsReadRecord, EventsSlice } from "../record/types.js";
import type { SecretSet } from "../secrets/types.js";
import { withoutChannelRecording } from "./channels.js";
import { EVENTS_LATE_FILE_NAME, keptLine, type ProducerStart, type WorldEventsFile } from "./events-file.js";
import { forEachLogLine, StepLines } from "./trace-slice.js";
import { traceIdIn } from "./trace-context.js";

// Responsibility: a claim step's reading of an earlier step's execution
// events, at the moment its claims are judged: the lines of that step's
// trace counted against each selection, as a range, written to
// `events-read.jsonl` beside the reading step's record. Boundary: what a
// line says and what a count says of a claim are src/execution-events/'s;
// which step produced the events, and the deadline, are the caller's;
// this module reads and waits.
//
// A reading starts at the byte the producer's slice began reading at, so
// it holds every line of the producer's trace, and the lines no step owns
// from then on: a request nukadoko did not stamp, or work the program
// traced on its own, may be the producer's, so such a line widens every
// count it could match. Lines another step owns do not: their trace says
// whose they are.
//
// The reading waits while the producer's events may still become whole:
// a request with no line yet, a job not yet performed, no line at all. It
// stops once they are whole, once a gap no more lines can close is open
// (the producer ran a process, a line of its trace did not read, the file
// was replaced), or when the deadline is near. It never waits until a
// claim would hold: it does not know the claims, and waiting for "one row
// was written" would make "nothing was written" hold before the write
// arrived. Waiting here, in the step that needs the answer, leaves the
// steps between the producer and the claim where they ran.
//
// A kind the world's program never reported, in this world, so far, keeps
// the reading of it from being whole (`kind-unreported`): a program that
// reports its requests and not its database would otherwise make "nothing
// was written" hold.
//
// The same reading works in every process that runs scenarios, since each
// only reads the world's file, and from a finished step record
// (`nuka do --use`): the producer's `events.jsonl` and `events-late.jsonl`
// hold every line of its trace the run saw, read again with the same
// tally. A recorded reading has no window: the lines no step owns were
// counted in the producer's slice and not kept, so each one widens every
// count by one, and the lines no step owns after the producer's record
// are not known.

/** The lines a claim step's readings counted, beside its record. */
export const EVENTS_READ_FILE_NAME = "events-read.jsonl";

const POLL_MS = 10;

/** Gaps more lines can close: the reading waits only while every open
 * gap is one of these. */
const CLOSABLE: ReadonlySet<EventsGap["gap"]> = new Set(["no-lines", "request-unreported", "jobs-pending"]);

/** The step whose events a reading counts, and where they are. */
export type EventsProducer =
  /** This process's handle sliced the step: the world's file, read from
   * where the step's slice began. */
  | { readonly source: "live"; readonly of: EventsProducerRecord; readonly start: ProducerStart; readonly file: WorldEventsFile }
  /** A finished step record's directory, whose world has stopped.
   * `world`, when given, is a copy of the world's file whose kinds count
   * as reported. */
  | {
      readonly source: "recorded";
      readonly of: EventsProducerRecord;
      readonly dir: string;
      readonly slice: EventsSlice;
      readonly lateTruncated?: boolean;
      readonly world?: string;
    }
  /** Why nothing can be read. */
  | { readonly source: "unread"; readonly of: EventsProducerRecord | null; readonly gap: "inlet-unnamed" | "world-unread" | "producer-not-run" };

/** One events key of a claim step. Keys that name one producer object
 * share one reading of its trace. */
export interface EventsRequest {
  readonly key: string;
  readonly producer: EventsProducer;
  readonly selection: EventSelection;
}

export interface EventsReadOptions {
  /** The time (epoch milliseconds) the reading stops waiting by. */
  readonly until: number;
  /** The reading step's record directory. */
  readonly dir: string;
  readonly secrets: SecretSet;
}

/** The tally inputs of a recorded slice: a record written before
 * `stamped_spans` existed matches none of its requests by span. */
export function tallyInputsOfSlice(slice: EventsSlice): Omit<TallyInputs, "selections"> {
  const spans = slice.stamped_spans ?? [];
  return {
    spans,
    spansNotKept: Math.max(0, slice.stamped - spans.length),
    ranProcesses: slice.open.some((gap) => gap.gap === "processes-unbounded"),
    processSpans: slice.process_spans ?? [],
  };
}

interface Group {
  readonly producer: Exclude<EventsProducer, { readonly source: "unread" }>;
  readonly requests: readonly EventsRequest[];
  readonly tally: TraceTally;
  /** A recorded reading's lines no step owns, counted and not kept. */
  unownedNotKept: number;
  truncated: boolean;
  replaced: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function traceIdOf(producer: Group["producer"]): string {
  return producer.source === "live" ? producer.start.traceId : producer.slice.trace_id;
}

/** Whether more lines can no longer change whether `group` is whole. */
function settled(group: Group): boolean {
  const reading = group.tally.reading({ truncated: group.truncated, replaced: group.replaced });
  return reading.whole || reading.open.some((gap) => !CLOSABLE.has(gap.gap));
}

/** Reads the live groups' world file forward, feeding each group's tally,
 * until every group is settled or `until` is near. */
async function readLive(groups: readonly Group[], file: WorldEventsFile, until: number, keep: (at: number, text: string, parsed: ParsedLine) => void): Promise<void> {
  const starts = groups.map((group) => (group.producer.source === "live" ? group.producer.start.from : 0));
  let offset = Math.min(...starts);
  let replaced = false;
  const fold = (text: string, at: number): void => {
    const parsed = parseEventLine(text);
    const textOwner = parsed.state === "unreadable" ? traceIdIn(text, file.prefix) : undefined;
    const owner = ownerOf(parsed, file.prefix);
    let counted = false;
    groups.forEach((group, index) => {
      if (at < starts[index]!) return;
      const traceId = traceIdOf(group.producer);
      if (parsed.state === "unreadable") {
        if (textOwner !== traceId) return;
        group.tally.damaged();
        counted = true;
      } else if (owner === traceId) {
        group.tally.owned(parsed);
        counted = true;
      } else if (owner === null) {
        group.tally.unowned(parsed);
        if (group.requests.some((request) => matchLine(request.selection, parsed) !== "no")) counted = true;
      }
    });
    if (counted) keep(at, text, parsed);
  };
  const read = (): void => {
    withoutChannelRecording(() => {
      try {
        if (!file.readable(offset)) {
          replaced = true;
          return;
        }
        offset = forEachLogLine(file.path, offset, (text, at) => {
          // A line that threw would end the read short of the offset it
          // reached, and the next read would count every line before it
          // again: the one line is left as far as it got instead.
          try {
            fold(text, at);
          } catch {
            // Above.
          }
        });
      } catch {
        // A file that cannot be read gives no lines.
      }
    });
    for (const group of groups) group.replaced = replaced;
  };
  for (;;) {
    read();
    if (groups.every(settled) || Date.now() + POLL_MS >= until) return;
    await sleep(POLL_MS);
  }
}

/** Folds a recorded producer's lines into its group's tally. */
function readRecorded(group: Group, kinds: KindsSeen, keep: (text: string, parsed: ParsedLine) => void): void {
  const producer = group.producer as Extract<EventsProducer, { readonly source: "recorded" }>;
  const { slice } = producer;
  const names = [slice.file, EVENTS_LATE_FILE_NAME].filter((name): name is string => name !== null);
  withoutChannelRecording(() => {
    for (const name of names) {
      try {
        forEachLogLine(path.join(producer.dir, name), 0, (text) => {
          const parsed = parseEventLine(text);
          kinds.note(parsed);
          // A copy holds only the step's own lines, each written again as
          // JSON: one that no longer reads is still one of them.
          if (parsed.state === "unreadable") group.tally.damaged();
          else if (parsed.trace.traceId === slice.trace_id) group.tally.owned(parsed);
          else return;
          keep(text, parsed);
        });
      } catch {
        // A file that cannot be read gives no lines.
      }
    }
    if (producer.world !== undefined) {
      try {
        forEachLogLine(producer.world, 0, (text) => kinds.note(parseEventLine(text)));
      } catch {
        // No copy of the world's file: only the step's own lines report kinds.
      }
    }
  });
  for (let line = 0; line < slice.unreadable; line += 1) group.tally.damaged();
  group.unownedNotKept = slice.unowned;
  group.truncated = slice.open.some((gap) => gap.gap === "truncated") || producer.lateTruncated === true;
  group.replaced = slice.open.some((gap) => gap.gap === "file-replaced");
}

const ORDER = new Map<string, number>(GAP_WORDS.map((word, index) => [word, index]));

function inOrder(open: readonly EventsGap[]): EventsGap[] {
  return [...open].sort((left, right) => ORDER.get(left.gap)! - ORDER.get(right.gap)!);
}

const NO_MAYBE: MaybeCounts = { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, commit_unknown: 0, unowned: 0 };

/** Reads each request's producer, waiting until every live producer's
 * events are whole, can no longer become whole, or `options.until` is
 * near (module header), and writes the lines it counted to
 * EVENTS_READ_FILE_NAME in `options.dir`. Returns each key's reading. */
export async function readEvents(requests: readonly EventsRequest[], options: EventsReadOptions): Promise<Readonly<Record<string, EventsReadRecord>>> {
  const started = Date.now();
  const byProducer = new Map<Group["producer"], EventsRequest[]>();
  for (const request of requests) {
    const { producer } = request;
    if (producer.source !== "unread") byProducer.set(producer, [...(byProducer.get(producer) ?? []), request]);
  }
  const groups = new Map<EventsProducer, Group>();
  for (const [producer, keys] of byProducer) {
    const inputs = producer.source === "live" ? producer.start.inputs : tallyInputsOfSlice(producer.slice);
    const tally = createTraceTally({ ...inputs, selections: keys.map((request) => request.selection) });
    groups.set(producer, { producer, requests: keys, tally, unownedNotKept: 0, truncated: false, replaced: false });
  }
  const kept = new StepLines();
  // A live line is kept once, by its byte, however many groups counted it.
  const liveKept = new Map<number, string>();
  const recordedKept: string[] = [];
  const recordedKinds = createKindsSeen();
  const byFile = new Map<WorldEventsFile, Group[]>();
  for (const group of groups.values()) {
    if (group.producer.source === "live") byFile.set(group.producer.file, [...(byFile.get(group.producer.file) ?? []), group]);
    else readRecorded(group, recordedKinds, (text, parsed) => recordedKept.push(keptLine(text, parsed, options.secrets)));
  }
  await Promise.all(
    [...byFile].map(([file, fileGroups]) =>
      readLive(fileGroups, file, options.until, (at, text, parsed) => {
        if (!liveKept.has(at)) liveKept.set(at, keptLine(text, parsed, options.secrets));
      }),
    ),
  );
  const waited = Date.now() - started;
  for (const at of [...liveKept.keys()].sort((left, right) => left - right)) kept.keep(liveKept.get(at)!);
  for (const text of recordedKept) kept.keep(text);
  const file = kept.write(options.dir, EVENTS_READ_FILE_NAME);
  const kindsOf = new Map<WorldEventsFile, KindsSeen>([...byFile.keys()].map((world) => [world, world.kindsSeen()]));
  const records: Record<string, EventsReadRecord> = {};
  for (const request of requests) {
    const { producer, selection } = request;
    if (producer.source === "unread") {
      records[request.key] = { of: producer.of, trace_id: null, count: selection, range: { at_least: 0, at_most: null }, whole: false, open: [{ gap: producer.gap }], maybe: NO_MAYBE, lines: 0, unreadable: 0, unowned: 0, file: null, waited_ms: 0 };
      continue;
    }
    const group = groups.get(producer)!;
    const truncated = group.truncated || kept.budget.truncated;
    const reading = group.tally.reading({ truncated, replaced: group.replaced });
    const index = group.requests.indexOf(request);
    const count = reading.counts[index]!;
    const maybe = { ...count.maybe, unowned: count.maybe.unowned + group.unownedNotKept };
    const kinds = producer.source === "live" ? kindsOf.get(producer.file)! : recordedKinds;
    const kind: EventKindName = selection.kind;
    const open = inOrder([...reading.open, ...(kinds.has(kind) ? [] : [{ gap: "kind-unreported" as const, kind }])]);
    const whole = open.length === 0;
    records[request.key] = {
      of: producer.of,
      trace_id: traceIdOf(producer),
      count: selection,
      range: rangeOf({ yes: count.yes, maybe }, whole),
      whole,
      open,
      maybe,
      lines: reading.lines,
      unreadable: reading.unreadable,
      unowned: producer.source === "live" ? reading.unowned : group.unownedNotKept,
      file,
      waited_ms: producer.source === "live" ? waited : 0,
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
  return records;
}
