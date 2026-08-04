import type { PollRecord } from "../receipt/types.js";

// Responsibility: the completion-order log of `ctx.poll` calls docs/spec.md's
// "Receipts" (`polls`) describes — same collector shape as sections.ts
// (record/snapshot/reset), owned and reset by the executor's step boundary
// (create-context.ts's `beginStep`), never reachable from a step's own `run`
// beyond the single write-only path `ctx.poll` drives through poll.ts's own
// internal loop (ctx-poll-receipt task spec).
//
// Not deduplicated, the same reasoning sections.ts already gives: each
// completed poll is a point in this execution's own sequence, not an
// identity worth citing once the way `used`'s receipt ids are.
//
// Appended in *completion* order, not call order (docs/spec.md "Receipts"):
// a poll nested inside another poll's own `fn` finishes first, and only a
// finished poll has `attempts`/`waited_ms` to report at all — recording at
// call time would have nothing to write down yet.

export interface PollsCollector {
  /** Appends one finished poll's own record. Called exactly once per
   * `ctx.poll` call that actually completes — resolved, timed out, or `fn`
   * itself threw (poll.ts's own `finally`, which runs on every one of
   * those three exits). */
  record(entry: PollRecord): void;
  /** The polls recorded since the last `reset()` (or since creation), in
   * completion order. */
  snapshot(): PollRecord[];
  /** Executor-only: clears the log at a step boundary. */
  reset(): void;
}

export function createPollsCollector(): PollsCollector {
  let entries: PollRecord[] = [];

  return {
    record(entry: PollRecord): void {
      entries.push(entry);
    },
    snapshot(): PollRecord[] {
      return [...entries];
    },
    reset(): void {
      entries = [];
    },
  };
}
