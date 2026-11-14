// Responsibility: the count of http.jsonl lines a step lost because the
// append failed (a missing directory, a full disk, a permission error). The
// step record's `http_log_failed` is this tally's read side. Without it a
// request that `observed` counted would be absent from http.jsonl with
// nothing to say a line was lost. Same collector shape as http-omitted.ts:
// executor-owned, reset at each step boundary by create-context.ts's
// `beginStep`, never reachable from a step's own `run`.

export interface HttpLogFailedCollector {
  /** Tallies one http.jsonl line that could not be appended. */
  record(): void;
  /** The count since the last `reset()`, or `undefined` when no append
   * failed, the "whole field omitted, not merely zero" convention
   * `http_omitted` follows. */
  snapshot(): number | undefined;
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

export function createHttpLogFailedCollector(): HttpLogFailedCollector {
  let count = 0;

  return {
    record(): void {
      count += 1;
    },
    snapshot(): number | undefined {
      return count > 0 ? count : undefined;
    },
    reset(): void {
      count = 0;
    },
  };
}
