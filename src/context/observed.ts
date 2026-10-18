import type { ObservedCounts, ProcessEntry } from "../record/types.js";

// Responsibility: the network-write observation tally docs/spec.md's
// "Keyword semantics" and "Records" (`observed`) describe — a single
// mutable collector shared by http-log.ts (ctx.request() calls) and
// browser-evidence.ts (page/browser-context requests) so neither module has
// to know about the other; both just call `record(method)` on whichever
// instance create-context.ts hands them. Kept in its own file rather than
// living inside either of those two: putting it in one would make the other
// import from it, and create-context.ts already imports both — a cycle.
//
// The same collector also keeps the processes `runCommand`
// (run-command.ts) started, because both answer one question: what did this
// execution reach outside its own process.
//
// Owned and reset by the executor's step boundary (create-context.ts's
// `beginStep`) — never reachable from a
// step's own `run`, the same trust-model rule every other evidence-
// collecting piece of `ctx` already follows (docs/spec.md: a step cannot
// control its own step record or evidence collection).

export interface ObservedCollector {
  /** Tallies one network call by its HTTP method: GET/HEAD as a read,
   * anything else as a write. Recorded
   * regardless of whether the call itself later succeeds or throws — the
   * tool observed the attempt through its own wrapper either way, and a
   * write attempt that fails on the wire is still a write the execution
   * made, not one it merely declared. */
  record(method: string): void;
  /** Says this boundary reached an HTTP channel nukadoko observes
   * (`ctx.request()`, `ctx.page()`, `pageAs()`), so its counts are numbers,
   * zero included. A boundary that neither reached one nor had a request
   * recorded reports `null` for both counts: a step that called `fetch`
   * made requests nothing here could see, and a 0 would read as a
   * measurement of them. */
  watchHttp(): void;
  /** Takes the next position in the process list when a process starts
   * (the list is `null` until the boundary's first `runCommand` call), and
   * returns the function that fills it when the process ends. Entries
   * therefore appear in start order, whatever order the processes finish
   * in. A position never filled (the process was still running when the
   * step record was built) is left out of the snapshot. */
  startProcess(): (entry: ProcessEntry) => void;
  /** A snapshot of the counts accumulated since the last `reset()` (or since
   * creation, for `nuka do`'s single execution-wide boundary). */
  snapshot(): ObservedCounts;
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

export function createObservedCollector(): ObservedCollector {
  let httpWatched = false;
  let httpReads = 0;
  let httpWrites = 0;
  let processes: (ProcessEntry | undefined)[] | null = null;

  return {
    watchHttp(): void {
      httpWatched = true;
    },
    record(method: string): void {
      httpWatched = true;
      if (READ_METHODS.has(method.toUpperCase())) {
        httpReads += 1;
      } else {
        httpWrites += 1;
      }
    },
    startProcess(): (entry: ProcessEntry) => void {
      // Captured, not re-read at fill time: a process that outlives a reset
      // fills the list it started in, never the next step's.
      processes ??= [];
      const list = processes;
      const index = list.length;
      list.push(undefined);
      return (entry) => {
        list[index] = entry;
      };
    },
    snapshot(): ObservedCounts {
      const ran = processes?.filter((entry): entry is ProcessEntry => entry !== undefined) ?? null;
      const http = httpWatched
        ? { http_reads: httpReads, http_writes: httpWrites }
        : { http_reads: null, http_writes: null };
      return { ...http, processes: ran };
    },
    reset(): void {
      httpWatched = false;
      httpReads = 0;
      httpWrites = 0;
      processes = null;
    },
  };
}
