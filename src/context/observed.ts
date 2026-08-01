// Responsibility: the network-write observation tally docs/spec.md's
// "Keyword semantics" and "Receipts" (`observed`) describe — a single
// mutable collector shared by http-log.ts (ctx.request() calls) and
// browser-evidence.ts (page/browser-context requests) so neither module has
// to know about the other; both just call `record(method)` on whichever
// instance create-context.ts hands them. Kept in its own file rather than
// living inside either of those two: putting it in one would make the other
// import from it, and create-context.ts already imports both — a cycle
// (this task's spec, scope items 1-2).
//
// Owned and reset by the executor's step boundary (create-context.ts's
// `beginStep`, this task's spec, decision 2) — never reachable from a
// step's own `run`, the same trust-model rule every other evidence-
// collecting piece of `ctx` already follows (docs/spec.md: a step cannot
// control its own receipt or evidence collection).

/** Read/write tally for one step boundary — `nuka do`'s whole execution, or
 * one `nuka run` pickle step (this task's spec, decision 2). Mirrors the
 * receipt's own `observed` shape (docs/spec.md "Receipts"). */
export interface ObservedCounts {
  http_reads: number;
  http_writes: number;
}

export interface ObservedCollector {
  /** Tallies one network call by its HTTP method: GET/HEAD as a read,
   * anything else as a write (this task's spec, decision 1). Recorded
   * regardless of whether the call itself later succeeds or throws — the
   * tool observed the attempt through its own wrapper either way, and a
   * write attempt that fails on the wire is still a write the execution
   * made, not one it merely declared. */
  record(method: string): void;
  /** A snapshot of the counts accumulated since the last `reset()` (or since
   * creation, for `nuka do`'s single execution-wide boundary). */
  snapshot(): ObservedCounts;
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

export function createObservedCollector(): ObservedCollector {
  let httpReads = 0;
  let httpWrites = 0;

  return {
    record(method: string): void {
      if (READ_METHODS.has(method.toUpperCase())) {
        httpReads += 1;
      } else {
        httpWrites += 1;
      }
    },
    snapshot(): ObservedCounts {
      return { http_reads: httpReads, http_writes: httpWrites };
    },
    reset(): void {
      httpReads = 0;
      httpWrites = 0;
    },
  };
}
