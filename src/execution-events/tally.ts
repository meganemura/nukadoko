import { createCommitIndex } from "./commit-state.js";
import { createLineGroups, type CountedGroup, type LeftOutGroup } from "./counted.js";
import type { EventKindName, JsonObject, ParsedLine, ReadableLine } from "./format.js";
import { matchLine, type EventSelection } from "./selection.js";
import { markOf, NO_MARKED_TABLES, tableRule, type WorldTables } from "./tables.js";

// Responsibility: what the lines of one trace say about the work they
// report, folded in the order the file holds them: how many there are of
// each kind, whether every request the step sent and every job it
// enqueued has reported its end, and, for each selection a count names,
// how many lines match, what they were (counted.ts), and how many may.
// Pure. Boundary: which lines are the trace's, and reading and redacting
// them, are the caller's; what a count's range says of a claim is
// count.ts's.
//
// The format writes an operation's line when the operation ends, after
// the lines of everything inside it (docs/execution-events.md "Inside
// first"). So a request's line closes what the request did, and a job's
// `perform` line closes that run of the job: the work a trace reports is
// whole once every request the step stamped has its line and every job
// enqueued in the trace has performed. A request's line names the span
// the step put in its `traceparent`, so each one is matched to the request
// that sent it; a line with a bare trace id stands for one request, which
// one unknown. Lines of several processes are in write order, not in time
// order, so a job's `perform` line may come before its `enqueue` line and
// the counts per job are compared, never their order. A `runCommand`
// process the step ran is work no count bounds while it may still run:
// the program it runs may send the world any number of requests, so a
// trace whose step ran one is not whole until it has closed and no
// process of its group is left (src/context/run-command.ts). From then on
// nothing it started can send another request, and the lines of the ones
// it sent are on their way like any request's: the step's slice waits
// for them as it does for its own (src/context/trace-slice.ts), and the
// world's stop counts again what came later. Its `TRACEPARENT` names a
// span of its own, so a request line that carries one is the process's
// request, told apart from the step's and never waited for by span: the
// process may send nothing.
//
// A count never drops a line it cannot read as a match or a miss. A line
// of the trace that is unreadable, of a kind the format does not define,
// of a later version, whose selected field is missing or invalid, or
// whose change persisted in a state no line decides yet, may be any line,
// and is counted as one that may match, by its cause. So is a readable
// line no step owns that the caller folds as the step's window (a request
// nukadoko did not stamp, work the program traced on its own), when it
// could match: it may be the step's work. A db line whose match depends on
// its commit state is kept until the reading, since a later `tx` line of
// the trace decides it, and decided then from every line folded so far,
// in any order.
//
// A line on a table the world's tables list marks as bookkeeping or
// infrastructure is left out of a db selection that names no table
// (tables.ts), and grouped apart, so a record names every line it left
// out and why; a line the tables cannot place may match
// (`holds_unknown`). Only a line that would have counted is named as
// left out: one that rolled back, or that its fields do not match, is
// not.
//
// Not whole is never read as "nothing more happened": each reason is one
// gap word, from one closed list, so a reader branches on the word.

/** Why a reading of a step's events may not hold everything its work did,
 * in the order a record lists them: why nothing was read, then what the
 * step's work leaves open, then what the world reported, then what was
 * lost on the way. */
export const GAP_WORDS = [
  "inlet-unnamed",
  "world-unread",
  "producer-not-run",
  "no-requests",
  "processes-unbounded",
  "no-lines",
  "request-unreported",
  "jobs-pending",
  "kind-unreported",
  "unreadable",
  "truncated",
  "file-replaced",
] as const;

export type GapWord = (typeof GAP_WORDS)[number];

/** A gap the lines of one trace show. */
export type TraceGap =
  /** The step sent the world no request with a `traceparent` and ran
   * no `runCommand` process: it caused no work a line could report the
   * end of, and no line can say that it caused none. */
  | { readonly gap: "no-requests" }
  /** A `runCommand` process the step ran may still send the world
   * requests (StepProcesses), and a program may send any number of them
   * or none, so no line can say all of them reported. */
  | { readonly gap: "processes-unbounded" }
  /** The step stamped requests and no line carries its trace id: no
   * writer, a wrong variable, or lines still buffered. */
  | { readonly gap: "no-lines" }
  /** This many of the step's stamped requests have no `request` line. */
  | { readonly gap: "request-unreported"; readonly requests: number }
  /** Jobs enqueued in the trace with fewer `perform` lines than
   * `enqueue` lines, by `job_id`. */
  | { readonly gap: "jobs-pending"; readonly job_ids: readonly string[] }
  /** This many lines whose text carries the trace id could not be read. */
  | { readonly gap: "unreadable"; readonly lines: number }
  /** The step's lines came to more than its file holds. */
  | { readonly gap: "truncated" }
  /** The events file was replaced or made shorter while it was read. */
  | { readonly gap: "file-replaced" };

/** A gap of a reading of a step's events: one its trace shows, or one
 * that keeps the reading from counting on all of the world's lines. */
export type EventsGap =
  | TraceGap
  /** The program file names no `{events}`, so the program has no file
   * to write events to. */
  | { readonly gap: "inlet-unnamed" }
  /** nukadoko did not start the world's program (a world at a URL, or
   * no world), so it reads no events there. */
  | { readonly gap: "world-unread" }
  /** No earlier line of the scenario ran the step whose events are
   * read. */
  | { readonly gap: "producer-not-run" }
  /** No line of the world's events file so far is an event of this
   * kind: a program that does not report the kind would make an absence
   * of it hold. */
  | { readonly gap: "kind-unreported"; readonly kind: EventKindName };

/** Why a line may match a selection, as a count's `maybe` names it. */
export const MAYBE_CAUSES = ["unreadable", "undefined_kind", "unknown_version", "field_unknown", "holds_unknown", "commit_unknown", "unowned"] as const;

export type MaybeCause = (typeof MAYBE_CAUSES)[number];

/** How many lines may match a selection, by cause (module header). */
export type MaybeCounts = Readonly<Record<MaybeCause, number>>;

/** One selection's count: lines that match, and lines that may. */
export interface SelectionCount {
  readonly yes: number;
  readonly maybe: MaybeCounts;
  /** The `yes` lines, grouped by what they were. */
  readonly counted: readonly CountedGroup[];
  /** The lines that would be `yes` by the selection's fields and that the
   * count leaves out, since their table holds bookkeeping or
   * infrastructure, grouped by what they were (module header). */
  readonly left_out: readonly LeftOutGroup[];
}

/** What the folded lines say so far. */
export interface TraceReading {
  /** Readable lines of the trace. */
  readonly lines: number;
  /** Readable lines by `kind`, a kind the format does not define under
   * its own name. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Lines whose text carries the trace id and that did not read. */
  readonly unreadable: number;
  /** Lines no step owns folded as the step's window. */
  readonly unowned: number;
  /** Request lines that name a span the step's processes got. */
  readonly processRequests: number;
  readonly whole: boolean;
  readonly open: readonly TraceGap[];
  /** One per selection the tally was made with, in order. */
  readonly counts: readonly SelectionCount[];
}

export interface TraceTally {
  /** A readable line whose trace is the tally's, in file order. */
  owned(line: ReadableLine): void;
  /** An unreadable line whose text carries the tally's trace id. */
  damaged(): void;
  /** A readable line no step owns, written in the step's window: it may
   * be the step's work (module header). */
  unowned(line: ReadableLine): void;
  /** What the lines folded so far say, with what the reader knows of the
   * file: whether it cut the lines it kept, and whether the file was
   * replaced under it. */
  reading(file: { readonly truncated: boolean; readonly replaced: boolean }): TraceReading;
}

/** What the step's `runCommand` processes leave open: it ran `none`;
 * each one `ended`, closed with no process of its group left; or one is
 * `unbounded`, since it still ran when the step's record was built, left
 * a process of its group running, or ran where nukadoko sees no group
 * (Windows). */
export type StepProcesses = "none" | "ended" | "unbounded";

export interface TallyInputs {
  /** The span ids of the requests the step sent with its `traceparent`. */
  readonly spans: readonly string[];
  /** Stamped requests past the span ids kept. */
  readonly spansNotKept: number;
  readonly processes: StepProcesses;
  /** The span ids of the `TRACEPARENT` values its processes got. */
  readonly processSpans: readonly string[];
  /** What the counts count, one count each, in order. */
  readonly selections?: readonly EventSelection[];
  /** What the world's tables list says: none marked when absent. */
  readonly tables?: WorldTables;
}

type Maybe = Record<MaybeCause, number>;

function noMaybe(): Maybe {
  return { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, holds_unknown: 0, commit_unknown: 0, unowned: 0 };
}

/** How a line whose match waits on its commit state counts once it is
 * decided: as the selection's fields say, as one that may be on a table
 * the count leaves out, or not at all, its table being left out. */
type AwaitingAs = "counted" | "unknown" | "left-out";

export function createTraceTally(inputs: TallyInputs): TraceTally {
  const stamped = new Set(inputs.spans);
  const reported = new Set<string>();
  const processSpans = new Set(inputs.processSpans);
  const selections = inputs.selections ?? [];
  const tables = inputs.tables ?? NO_MARKED_TABLES;
  let processRequests = 0;
  let bare = 0;
  let lines = 0;
  let unreadable = 0;
  let unowned = 0;
  const kinds = new Map<string, number>();
  const jobs = new Map<string, { enqueues: number; performs: number }>();
  const commits = createCommitIndex();
  const counts = selections.map(() => ({ yes: 0, maybe: noMaybe() }));
  const grouped = selections.map((selection) => createLineGroups(selection.kind));
  const leftOut = selections.map((selection) => createLineGroups(selection.kind));
  // Per selection, the db lines that match it if their change persisted
  // as it states: decided at each reading (module header).
  const awaitingCommit = selections.map((): { readonly object: JsonObject; readonly as: AwaitingAs }[] => []);
  return {
    owned(line) {
      lines += 1;
      kinds.set(line.kind, (kinds.get(line.kind) ?? 0) + 1);
      commits.note(line);
      selections.forEach((selection, index) => {
        const match = matchLine(selection, line);
        if (match === "no") return;
        const rule = tableRule(selection, line, tables);
        const count = counts[index]!;
        if (match === "commit-state") awaitingCommit[index]!.push({ object: line.object, as: rule === "counted" || rule === "unknown" ? rule : "left-out" });
        else if (rule === "counted") {
          if (match === "yes") {
            count.yes += 1;
            grouped[index]!.add(line.object);
          } else count.maybe[match] += 1;
        } else if (rule === "unknown") count.maybe[match === "yes" ? "holds_unknown" : match] += 1;
        // A line on a table the count leaves out cannot count, whatever
        // its other fields hold.
        else if (match === "yes") leftOut[index]!.add(line.object);
      });
      if (line.state !== "event") return;
      if (line.kind === "request") {
        if (line.trace.span === null) bare += 1;
        else if (stamped.has(line.trace.span)) reported.add(line.trace.span);
        else if (processSpans.has(line.trace.span)) processRequests += 1;
      } else if (line.kind === "job") {
        // The parser read both as the format requires, or the line would
        // not be an event.
        const id = line.object.job_id as string;
        const job = jobs.get(id) ?? { enqueues: 0, performs: 0 };
        if (line.object.phase === "enqueue") job.enqueues += 1;
        else job.performs += 1;
        jobs.set(id, job);
      }
    },
    damaged() {
      unreadable += 1;
      for (const count of counts) count.maybe.unreadable += 1;
    },
    unowned(line) {
      unowned += 1;
      selections.forEach((selection, index) => {
        if (matchLine(selection, line) === "no") return;
        const rule = tableRule(selection, line, tables);
        if (rule === "counted" || rule === "unknown") counts[index]!.maybe.unowned += 1;
      });
    },
    reading(file) {
      const requests = stamped.size + inputs.spansNotKept;
      const unmatched = Math.max(0, requests - reported.size - bare);
      const pending = [...jobs].filter(([, job]) => job.performs < job.enqueues).map(([id]) => id);
      const silent = requests > 0 && lines === 0 && unreadable === 0 && !file.replaced;
      const open: TraceGap[] = [
        ...(requests === 0 && inputs.processes === "none" ? [{ gap: "no-requests" as const }] : []),
        ...(inputs.processes === "unbounded" ? [{ gap: "processes-unbounded" as const }] : []),
        ...(silent ? [{ gap: "no-lines" as const }] : []),
        ...(!silent && unmatched > 0 ? [{ gap: "request-unreported" as const, requests: unmatched }] : []),
        ...(pending.length > 0 ? [{ gap: "jobs-pending" as const, job_ids: pending }] : []),
        ...(unreadable > 0 ? [{ gap: "unreadable" as const, lines: unreadable }] : []),
        ...(file.truncated ? [{ gap: "truncated" as const }] : []),
        ...(file.replaced ? [{ gap: "file-replaced" as const }] : []),
      ];
      const decided = selections.map((selection, index): SelectionCount => {
        const count = counts[index]!;
        const wanted = "committed" in selection && selection.committed === true ? "persisted" : "not-persisted";
        const matched: JsonObject[] = [];
        const outMatched: JsonObject[] = [];
        let unknown = 0;
        let holdsUnknown = 0;
        for (const { object, as } of awaitingCommit[index]!) {
          const state = commits.stateOf(object);
          if (state === "unknown") {
            if (as !== "left-out") unknown += 1;
          } else if (state === wanted) {
            if (as === "counted") matched.push(object);
            else if (as === "unknown") holdsUnknown += 1;
            else outMatched.push(object);
          }
        }
        return {
          yes: count.yes + matched.length,
          maybe: { ...count.maybe, holds_unknown: count.maybe.holds_unknown + holdsUnknown, commit_unknown: count.maybe.commit_unknown + unknown },
          counted: grouped[index]!.groups(matched),
          left_out: leftOut[index]!.groups(outMatched).map((group) => ({ ...group, holds: markOf(tables, group.fields.table)! })),
        };
      });
      return { lines, kinds: Object.fromEntries(kinds), unreadable, unowned, processRequests, whole: open.length === 0, open, counts: decided };
    },
  };
}

/** The kinds a world's program has reported so far: a kind is reported
 * once one line of the world's file is an event of it, whatever trace the
 * line carries. A program that never wrote a db line has not said that it
 * wrote none. */
export interface KindsSeen {
  /** A line of the world's file, in any order. */
  note(line: ParsedLine): void;
  has(kind: EventKindName): boolean;
}

/** The gaps of a reading of a selection of `kind`: the trace's, and
 * `kind-unreported` when the world's program has reported no line of
 * `kind`, in the order GAP_WORDS lists them. Pure. */
export function readingGaps(open: readonly EventsGap[], kind: EventKindName, kinds: KindsSeen): EventsGap[] {
  const gaps: EventsGap[] = kinds.has(kind) ? [...open] : [...open, { gap: "kind-unreported", kind }];
  return gaps.sort((left, right) => GAP_WORDS.indexOf(left.gap) - GAP_WORDS.indexOf(right.gap));
}

export function createKindsSeen(): KindsSeen {
  const seen = new Set<EventKindName>();
  return {
    note(line) {
      if (line.state === "event") seen.add(line.kind);
    },
    has(kind) {
      return seen.has(kind);
    },
  };
}
