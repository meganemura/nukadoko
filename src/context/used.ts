// Responsibility: the provenance tally docs/spec.md's "Receipts" (`used`)
// describes — which earlier steps' validated results this execution actually
// read, whether through `ctx.resultOf` (m2pre-resultof task spec, decision 2)
// or through a `from` injection (m6a-from-core task spec, item 5). Its own
// file for the same reason observed.ts is its own file: create-context.ts is
// the one module that wires `ctx.resultOf` and owns the step boundary, and
// src/run/run-scenario.ts is the one place a `from` injection happens — both
// call into the same collector instance through `create-context.ts`'s handle
// (`resultOf`'s internal wrapper for the first, `recordUsed` for the second),
// so a step that both gets a value injected *and* separately calls
// `ctx.resultOf` for a different upstream still ends up with one deduplicated
// list, not two independent ones.
//
// `record`'s shape changed from a bare receipt id to `{ receiptId, stepName }`
// now (m6a-from-core task spec, item 5; docs/spec.md "Receipts": each `used`
// entry is `{ "receipt": "rcpt-…", "step": "create-project" }`) — a receipt
// that has to be resolved against other files to be read is a worse
// acceptance record than one that is legible alone, and the file it would be
// resolved against (another receipt) is a local working record a sign-off
// long outlives. Breaking change, no shim: 0.1 hasn't shipped yet.
//
// Deduplicated and in read order (m2pre-resultof task spec, decision 2: dedupe,
// then order by first read) — a step that reads the same earlier step's
// result more than once (whether via `resultOf`, `from`, or a mix of both)
// must not cite that receipt id twice in `used`.

export interface UsedEntry {
  readonly receipt: string;
  readonly step: string;
}

export interface UsedCollector {
  /** Tallies one successful read (`ctx.resultOf`, or a `from` injection) by
   * the receipt id it read its value from and the step name that receipt
   * itself records. Never called for a read that returned nothing —
   * provenance is only recorded for what was actually read. */
  record(receiptId: string, stepName: string): void;
  /** The reads recorded since the last `reset()` (or since creation),
   * deduplicated by receipt id, in the order first read. */
  snapshot(): UsedEntry[];
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

export function createUsedCollector(): UsedCollector {
  // A `Map` (not a `Set` + parallel array) keeps "have we seen this receipt
  // id" and "which step name to report for it" in the one structure, while
  // still preserving first-insertion order the same way the array-based
  // implementation did — JS `Map` iteration order is insertion order, and a
  // `.set()` on an already-present key does not move it, so a duplicate read
  // never reorders anything either.
  let seen = new Map<string, string>();

  return {
    record(receiptId: string, stepName: string): void {
      if (!seen.has(receiptId)) {
        seen.set(receiptId, stepName);
      }
    },
    snapshot(): UsedEntry[] {
      return [...seen.entries()].map(([receipt, step]) => ({ receipt, step }));
    },
    reset(): void {
      seen = new Map<string, string>();
    },
  };
}
