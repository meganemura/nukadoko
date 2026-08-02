// Responsibility: the provenance tally docs/spec.md's "Receipts" (`used`)
// describes — which earlier steps' validated results this execution actually
// read through `ctx.resultOf` (m2pre-resultof task spec, decision 2). Its own
// file for the same reason observed.ts is its own file: create-context.ts is
// the one module that both wires `ctx.resultOf` and owns the step boundary,
// so it is the only caller of both `record` (inside the `resultOf` wrapper,
// never itself exposed on `ctx`) and `reset` (`beginStep`, once per `nuka
// run` pickle step; `nuka do`'s single execution-wide boundary never resets
// it).
//
// Deduplicated and in read order (this task's spec, decision 2: "重複排除・
// 読んだ順") — a step that reads the same earlier step's result more than
// once must not cite that receipt id twice in `used`.

export interface UsedCollector {
  /** Tallies one successful `ctx.resultOf` read by the receipt id it read
   * its value from. Never called for a read that returned `undefined` —
   * provenance is only recorded for what was actually read. */
  record(receiptId: string): void;
  /** The receipt ids read since the last `reset()` (or since creation),
   * deduplicated, in the order first read. */
  snapshot(): string[];
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

export function createUsedCollector(): UsedCollector {
  let seen = new Set<string>();
  let order: string[] = [];

  return {
    record(receiptId: string): void {
      if (!seen.has(receiptId)) {
        seen.add(receiptId);
        order.push(receiptId);
      }
    },
    snapshot(): string[] {
      return [...order];
    },
    reset(): void {
      seen = new Set<string>();
      order = [];
    },
  };
}
