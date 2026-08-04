import type { SectionEntry } from "../receipt/types.js";

// Responsibility: the ordered log of `ctx.section` calls docs/spec.md's
// "Receipts" (`sections`) describes — same collector shape as observed.ts
// and used.ts (t3-sections task spec, decision 4), owned and reset by the
// executor's step boundary (create-context.ts's `beginStep`), never
// reachable from a step's own `run` beyond the single write-only
// `ctx.section(label)` call.
//
// Unlike used.ts, this is not deduplicated: `used` names a receipt id (an
// identity, worth citing once), while a section label is a point in a
// sequence — a step that re-enters the same label twice (a loop, a retry)
// did so twice, and the receipt should say so: an array ordered by call
// order, not a set (this task's spec, decision 2).
//
// Each entry now carries `at` (fb4-evidence-time task spec, item 3) — taken
// here, by this collector, at the moment `record` is called, never passed in
// by `ctx.section`'s own caller: `record(label)`'s own signature is
// unchanged on purpose (this task's spec: a step supplying its own timestamp
// would be a claim, not a measurement — the same self-reported/measured line
// `declared:`-prefixed Allure attachments already draw).

export interface SectionsCollector {
  /** Appends `label`, paired with the current time, to the call-order log.
   * Never throws, never returns — this task's spec, decision 1:
   * `ctx.section` is a plain marker, not a span that could fail to open or
   * close. */
  record(label: string): void;
  /** The entries recorded since the last `reset()` (or since creation), in
   * call order. */
  snapshot(): SectionEntry[];
  /** Executor-only: clears the log at a step boundary. */
  reset(): void;
}

export function createSectionsCollector(): SectionsCollector {
  let entries: SectionEntry[] = [];

  return {
    record(label: string): void {
      entries.push({ label, at: new Date().toISOString() });
    },
    snapshot(): SectionEntry[] {
      return [...entries];
    },
    reset(): void {
      entries = [];
    },
  };
}
