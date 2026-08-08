// Responsibility: the provenance tally docs/spec.md's "Receipts" (`used`)
// describes — which earlier steps' validated results this execution actually
// read, whether through `ctx.resultOf`
// or through a `from` injection. Its own
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
// now (docs/spec.md "Receipts": each `used`
// entry is `{ "receipt": "rcpt-…", "step": "create-project" }`) — a receipt
// that has to be resolved against other files to be read is a worse
// acceptance record than one that is legible alone, and the file it would be
// resolved against (another receipt) is a local working record a sign-off
// long outlives. Breaking change, no shim: 0.1 hasn't shipped yet.
//
// Deduplicated and in read order (dedupe, then order by first read) — a
// step that reads the same earlier step's
// result more than once (whether via `resultOf`, `from`, or a mix of both)
// must not cite that receipt id twice in `used`.
//
// `result`: the upstream's own
// validated result, carried alongside the id/step pointer `used` already
// had — added so a *failed* step's receipt can be read alone instead of
// requiring a second receipt.json to be opened just to see what it read.
// Recorded here unconditionally (every `record()` call gets one; this
// collector has no idea yet whether the step reading it will end up "ok" or
// "failed") — it is the receipt-construction site (run-scenario.ts's
// `finishExecutedStep`, cli/do.ts) that strips it back off for an "ok"
// receipt (success is redundant — the value is already sitting
// on that step's own `args`/upstream receipt). The full result, not the one
// key a `from` injection happened to read: a diagnosis needs
// "why did this value come out this way", and narrowing to the cited key
// would recreate, on the receipt side, the same citation-only trap
// `skills/acceptance/SKILL.md`'s `returns` guidance already warns against.
//
// `UsedEntry` vs `UsedEntryWithResult`: a bare optional `result?: unknown` let a new
// receipt-construction site forget to strip it and still compile — the same
// shape of trap this repo already hit once with a non-exhaustive ternary
// silently swallowing a new variant. What has to hold is narrower than
// "success is redundant": a *successful* run's receipt is the public face a
// user reads with jq, and if `result` ever leaks onto one, a reader learns
// "it's there on success too", starts depending on that, and the leak breaks
// them silently when someone later closes it — the failing side never says
// anything, which is exactly the kind of mistake docs/spec.md's "Nothing
// breaks silently" principle exists to rule out.
//
// A plain structural extension (`UsedEntry & { result: unknown }`) does not
// rule it out: TypeScript is structurally typed, so a `{ receipt, step,
// result }` value is assignable wherever `{ receipt, step }` is expected
// regardless of whether the wider type nominally "extends" the narrower one
// — the same is true even without any inheritance relationship at all, since
// assignability only ever looks at shape. Renaming the interface or
// duplicating its fields into an unrelated one doesn't change that either.
// The only way to make TypeScript actually refuse the wider shape is an
// *exclusion marker*: `result?: never` on `UsedEntry` below says "this
// field, if present at all, can never hold a value" — an optional `never`
// still allows a plain `{ receipt, step }` object through untouched (no
// `result` key at all satisfies "optional and absent"), but rejects any
// value that supplies a real `result: unknown`, because `unknown` can't
// narrow to `never`. `UsedEntryWithResult` then has to `Omit` that marker
// before re-adding `result` as `unknown` — intersecting directly
// (`UsedEntry & { result: unknown }`) would collapse to `result: never`
// instead (`never & unknown` is `never`), which would make the type
// impossible to construct at all. This is the same vocabulary the repo
// already uses to close off silent gaps elsewhere: a non-exhaustive ternary
// swallowing a new variant is what turned this codebase toward `switch` +
// `never` in the first place — `never` as "the compiler proves this branch
// (here, this field) cannot be reached with a real value."

export interface UsedEntry {
  readonly receipt: string;
  readonly step: string;
  /** Exclusion marker, not a real field (see this file's header) — always
   * absent on an actual `UsedEntry`. Its only job is to make a
   * result-bearing `UsedEntryWithResult` fail to structurally satisfy
   * `UsedEntry` wherever an array of it is expected, so a receipt-
   * construction site that forgets to call `omitUsedResults` before handing
   * an "ok" receipt its `used` array gets a compile error instead of a
   * silent leak. */
  readonly result?: never;
}

/** `UsedEntry` with its exclusion marker replaced by a real, required
 * `result` — the upstream receipt's full validated result. `Omit` first
 * (rather than intersecting `UsedEntry` directly with `{ result: unknown }`)
 * because `result?: never` intersected with `result: unknown` collapses to
 * `result: never`, an uninhabitable field; `Omit` removes the marker before
 * `unknown` replaces it, so this type is actually constructible. */
export type UsedEntryWithResult = Omit<UsedEntry, "result"> & {
  readonly result: unknown;
};

export interface UsedCollector {
  /** Tallies one successful read (`ctx.resultOf`, or a `from` injection) by
   * the receipt id it read its value from, the step name that receipt
   * itself records, and the upstream's own validated result. Never called
   * for a read that returned nothing — provenance is only recorded for what
   * was actually read. */
  record(receiptId: string, stepName: string, result: unknown): void;
  /** The reads recorded since the last `reset()` (or since creation),
   * deduplicated by receipt id, in the order first read. Every entry
   * carries `result` unconditionally — a caller building an "ok" receipt
   * must strip it itself. */
  snapshot(): UsedEntryWithResult[];
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

/** Strips `result` from every entry
 * — the shared helper both `nuka run` (run-scenario.ts) and `nuka do`
 * (cli/do.ts) call when building an "ok" receipt, so a successful
 * execution's `used` keeps the `{ receipt, step }` shape it always has and
 * never carries the redundant upstream value success doesn't need. */
export function omitUsedResults(entries: readonly UsedEntryWithResult[]): UsedEntry[] {
  return entries.map(({ receipt, step }) => ({ receipt, step }));
}

export function createUsedCollector(): UsedCollector {
  // A `Map` (not a `Set` + parallel array) keeps "have we seen this receipt
  // id" and "which step name/result to report for it" in the one structure,
  // while still preserving first-insertion order the same way the
  // array-based implementation did — JS `Map` iteration order is insertion
  // order, and a `.set()` on an already-present key does not move it, so a
  // duplicate read never reorders anything either.
  let seen = new Map<string, { readonly step: string; readonly result: unknown }>();

  return {
    record(receiptId: string, stepName: string, result: unknown): void {
      if (!seen.has(receiptId)) {
        seen.set(receiptId, { step: stepName, result });
      }
    },
    snapshot(): UsedEntryWithResult[] {
      return [...seen.entries()].map(([receipt, { step, result }]) => ({ receipt, step, result }));
    },
    reset(): void {
      seen = new Map();
    },
  };
}
