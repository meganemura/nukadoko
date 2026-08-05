// Responsibility: the "what got left out of http.jsonl" tally docs/spec.md's
// "Receipts" (`http_omitted`) describes (p3b-page-network task spec, scope
// item 2). A page load's own image/stylesheet/script/etc requests are
// deliberately never written to http.jsonl — only document/xhr/fetch are
// (page-http-log.ts owns that allowlist) — and this collector is what keeps
// that omission from being silent: every request left out is tallied here,
// by Playwright's own `request.resourceType()`, so a step's receipt can say
// how many were dropped and of what kind instead of a reader having to
// assume http.jsonl already shows everything (CLAUDE.md "Nothing breaks
// silently"). Same collector shape as observed.ts/page-events.ts
// (`record()`/`snapshot()`/`reset()`, executor-owned, reset at each step
// boundary by create-context.ts's `beginStep`, never reachable from a
// step's own `run`).
//
// Deliberately separate from `observed` (observed.ts): `observed` counts
// every request the harness saw, whether or not http.jsonl went on to keep
// it — it answers "how many reads and writes actually happened". This
// collector answers a different question, "how much did http.jsonl leave
// out, and of what kind" — the two numbers are not expected to add up to
// each other, and neither http-log.ts nor page-http-log.ts ever tries to
// make them (docs/spec.md "Receipts").

/** Dropped-request counts by Playwright's own `request.resourceType()`
 * (`"image"`, `"stylesheet"`, `"script"`, ...) — the receipt's own
 * `http_omitted` shape, e.g. `{ "image": 34, "stylesheet": 5 }`. */
export interface HttpOmittedCounts {
  [resourceType: string]: number;
}

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
