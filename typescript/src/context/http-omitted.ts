import type { HttpOmittedCounts } from "../record/types.js";

// Responsibility: the "what got left out of http.jsonl" tally docs/spec.md's
// "Records" (`http_omitted`) describes. A page load's own
// image/stylesheet/script/etc requests are deliberately never written to
// http.jsonl — only document/xhr/fetch are
// (page-http-log.ts owns that allowlist) — and this collector is what keeps
// that omission from being silent: every request left out is tallied here,
// by Playwright's own `request.resourceType()`, so a step's own step record
// can say
// how many were dropped and of what kind instead of a reader having to
// assume http.jsonl already shows everything. Same collector shape as page-events.ts
// (`record()`/`snapshot()`/`reset()`, executor-owned, reset at each step
// boundary by create-context.ts's `beginStep`, never reachable from a
// step's own `run`).

export interface HttpOmittedCollector {
  /** Tallies one request left out of http.jsonl, by its own resourceType. */
  record(resourceType: string): void;
  /** Counts accumulated since the last `reset()` (or since creation), or
   * `undefined` when nothing was ever left out this boundary — the same
   * "whole field omitted, not merely empty" convention `page_events`'s own
   * `snapshot()` (page-events.ts) already follows. */
  snapshot(): HttpOmittedCounts | undefined;
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

export function createHttpOmittedCollector(): HttpOmittedCollector {
  let counts: Record<string, number> = {};

  return {
    record(resourceType: string): void {
      counts[resourceType] = (counts[resourceType] ?? 0) + 1;
    },
    snapshot(): HttpOmittedCounts | undefined {
      return Object.keys(counts).length > 0 ? { ...counts } : undefined;
    },
    reset(): void {
      counts = {};
    },
  };
}
