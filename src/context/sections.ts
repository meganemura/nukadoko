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
// did so twice, and the receipt should say so. "呼ばれた順に並べた配列",
// not a set (this task's spec, decision 2).

export interface SectionsCollector {
  /** Appends `label` to the call-order log. Never throws, never returns —
   * this task's spec, decision 1: `ctx.section` is a plain marker, not a
   * span that could fail to open or close. */
  record(label: string): void;
  /** The labels recorded since the last `reset()` (or since creation), in
   * call order. */
  snapshot(): string[];
  /** Executor-only: clears the log at a step boundary. */
  reset(): void;
}

export function createSectionsCollector(): SectionsCollector {
  let labels: string[] = [];

  return {
    record(label: string): void {
      labels.push(label);
    },
    snapshot(): string[] {
      return [...labels];
    },
    reset(): void {
      labels = [];
    },
  };
}
