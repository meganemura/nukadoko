import type { ReadableLine } from "./format.js";

// Responsibility: what the lines of one trace say about the work they
// report, folded in the order the file holds them: how many there are of
// each kind, and whether every request the step sent and every job it
// enqueued has reported its end. Pure. Boundary: which lines are the
// trace's, and reading and redacting them, are the caller's.
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
// process the step ran is work no count bounds: the program it runs may
// send the world any number of requests, so a trace whose step ran one is
// never whole.
//
// Not whole is never read as "nothing more happened": each reason is one
// gap word, from one closed list, so a reader branches on the word.

/** Why a step's events may not hold everything its work did, in the order
 * a record lists them. */
export const GAP_WORDS = ["no-requests", "processes-unbounded", "no-lines", "request-unreported", "jobs-pending", "unreadable", "truncated", "file-replaced"] as const;

export type GapWord = (typeof GAP_WORDS)[number];

export type EventsGap =
  /** The step sent the world no request with a `traceparent` and ran
   * no `runCommand` process: it caused no work a line could report the
   * end of, and no line can say that it caused none. */
  | { readonly gap: "no-requests" }
  /** The step ran a `runCommand` process. What that process sent the
   * world is not counted, since a program may send any number of
   * requests or none, so no line can say all of them reported. */
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

/** What the folded lines say so far. */
export interface TraceReading {
  /** Readable lines of the trace. */
  readonly lines: number;
  /** Readable lines by `kind`, a kind the format does not define under
   * its own name. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Lines whose text carries the trace id and that did not read. */
  readonly unreadable: number;
  readonly whole: boolean;
  readonly open: readonly EventsGap[];
}

export interface TraceTally {
  /** A readable line whose trace is the tally's, in file order. */
  owned(line: ReadableLine): void;
  /** An unreadable line whose text carries the tally's trace id. */
  damaged(): void;
  /** What the lines folded so far say, with what the reader knows of the
   * file: whether it cut the lines it kept, and whether the file was
   * replaced under it. */
  reading(file: { readonly truncated: boolean; readonly replaced: boolean }): TraceReading;
}

export interface TallyInputs {
  /** The span ids of the requests the step sent with its `traceparent`. */
  readonly spans: readonly string[];
  /** Stamped requests past the span ids kept. */
  readonly spansNotKept: number;
  /** Whether the step ran a `runCommand` process. */
  readonly ranProcesses: boolean;
}

export function createTraceTally(inputs: TallyInputs): TraceTally {
  const stamped = new Set(inputs.spans);
  const reported = new Set<string>();
  let bare = 0;
  let lines = 0;
  let unreadable = 0;
  const kinds = new Map<string, number>();
  const jobs = new Map<string, { enqueues: number; performs: number }>();
  return {
    owned(line) {
      lines += 1;
      kinds.set(line.kind, (kinds.get(line.kind) ?? 0) + 1);
      if (line.state !== "event") return;
      if (line.kind === "request") {
        if (line.trace.span === null) bare += 1;
        else if (stamped.has(line.trace.span)) reported.add(line.trace.span);
      } else if (line.kind === "job") {
        // The parser read both as the format requires, or the line would
        // not be an event.
        const id = line.object.job_id as string;
        const counts = jobs.get(id) ?? { enqueues: 0, performs: 0 };
        if (line.object.phase === "enqueue") counts.enqueues += 1;
        else counts.performs += 1;
        jobs.set(id, counts);
      }
    },
    damaged() {
      unreadable += 1;
    },
    reading(file) {
      const requests = stamped.size + inputs.spansNotKept;
      const unmatched = Math.max(0, requests - reported.size - bare);
      const pending = [...jobs].filter(([, counts]) => counts.performs < counts.enqueues).map(([id]) => id);
      const silent = requests > 0 && lines === 0 && unreadable === 0 && !file.replaced;
      const open: EventsGap[] = [
        ...(requests === 0 && !inputs.ranProcesses ? [{ gap: "no-requests" as const }] : []),
        ...(inputs.ranProcesses ? [{ gap: "processes-unbounded" as const }] : []),
        ...(silent ? [{ gap: "no-lines" as const }] : []),
        ...(!silent && unmatched > 0 ? [{ gap: "request-unreported" as const, requests: unmatched }] : []),
        ...(pending.length > 0 ? [{ gap: "jobs-pending" as const, job_ids: pending }] : []),
        ...(unreadable > 0 ? [{ gap: "unreadable" as const, lines: unreadable }] : []),
        ...(file.truncated ? [{ gap: "truncated" as const }] : []),
        ...(file.replaced ? [{ gap: "file-replaced" as const }] : []),
      ];
      return { lines, kinds: Object.fromEntries(kinds), unreadable, whole: open.length === 0, open };
    },
  };
}
