import type { UsedEntryWithResult } from "../context/used.js";
import type { Receipt } from "../receipt/types.js";
import { fromCandidates, type Step } from "../step/define-step.js";

// Responsibility: `nuka do --use <receipt-id>`'s own lookup (docs/spec.md
// "Single steps (the agent path)", the `--use` paragraph) — turns one
// receipt id into whichever of the step actually being run's own
// `from` keys that receipt's result fills. A pure function around one
// receipt id at a time, returning a result rather than throwing (same shape
// as src/step/validate-from.ts's `validateStepFrom`): `nuka do`'s own setup
// phase (src/cli/do.ts) is the thing that knows a non-`ok` result here means
// stderr + exit 1 with no receipt written, not this module.
//
// `readReceipt` and `stepNameOf` are both injected rather than built here —
// `readReceipt` so a test can supply a fake without touching disk (the real
// one is src/receipt/read-receipt.ts's `readReceiptById`, closed over
// `rootDir`/`config.stateDir` by the caller), and `stepNameOf` because it is
// the same "Step object -> the vocabulary name discovery registered it
// under" map `nuka do`'s own `isRegisteredStep` predicate is built from
// (one vocabulary walk, not two).
//
// A key naming several candidate producers matches this receipt against
// every one of them via `fromCandidates`, exactly the way a
// single-candidate key already did — one receipt can therefore still fill a
// key whose `from` lists several candidates, as long as its own step is one
// of them. What this module does *not* do is notice when two different
// `--use` values end up filling the same key from two *different*
// candidates — that cross-call comparison needs every `--use` value's own
// result side by side, which only this function's caller (src/cli/do.ts)
// has, and that is where the conflict check lives instead.

export interface ResolveUseError {
  readonly ok: false;
  readonly message: string;
}

export interface ResolveUseSuccess {
  readonly ok: true;
  /** Every args key this receipt's `result` filled, keyed the same way
   * `step.from`'s own keys are — `nuka do`'s own caller still has to check
   * each key against `--args` before actually writing it in (`--args` wins
   * for a key it already set), so this is offered up unconditionally, not
   * pre-filtered. */
  readonly filled: Readonly<Record<string, unknown>>;
  /** The `{ receipt, step, result }` shape the `used` collector
   * (src/context/used.ts) already records — handed straight to
   * `StepContextHandle.recordUsed`, the sole path into that collector, once
   * the caller decides at least one of `filled`'s keys actually landed.
   * `result` is this upstream receipt's own full validated result, always
   * populated here (this function only ever reaches this point for a
   * receipt whose `status` is already checked `"ok"`, above); the caller
   * strips it back off for an "ok" receipt of its own the same way
   * run-scenario.ts's `finishExecutedStep` does. */
  readonly used: UsedEntryWithResult;
}

export type ResolveUseResult = ResolveUseError | ResolveUseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves one `--use <receiptId>` against `step`'s own `from` declaration.
 * Checked in this order: unknown id, a non-`"ok"` receipt, a receipt whose
 * step names none of `step.from`'s upstreams, then — per matching entry — a
 * `result` missing the key that entry names.
 */
export function resolveUse(
  receiptId: string,
  step: Step,
  stepNameOf: ReadonlyMap<Step, string>,
  readReceipt: (receiptId: string) => Receipt | null,
): ResolveUseResult {
  const receipt = readReceipt(receiptId);
  if (receipt === null) {
    return { ok: false, message: `--use ${receiptId}: no such receipt` };
  }

  if (receipt.status !== "ok") {
    return {
      ok: false,
      message: `--use ${receiptId}: this receipt's status is "${receipt.status}", not "ok". A failed execution has no validated result to read`,
    };
  }

  // Entries (plural on purpose — docs/spec.md's own wording): a single
  // upstream step can be named by more than one of this step's `from` keys,
  // and one matching receipt fills all of them. Each key's own candidates
  // are checked individually via `fromCandidates`, so a key whose `from`
  // lists several producers still matches as long as one of them is this
  // receipt's own step.
  const matches: Array<readonly [key: string, upstreamKey: string]> = [];
  for (const [key, entry] of Object.entries(step.from)) {
    for (const [upstream, upstreamKey] of fromCandidates(entry)) {
      if (stepNameOf.get(upstream) === receipt.step) {
        matches.push([key, upstreamKey]);
      }
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message: `--use ${receiptId}: its step "${receipt.step}" is not named by any of this step's \`from\` entries`,
    };
  }

  const result = receipt.result;
  const filled: Record<string, unknown> = {};
  for (const [key, upstreamKey] of matches) {
    if (!isRecord(result) || !(upstreamKey in result)) {
      return {
        ok: false,
        message: `--use ${receiptId}: its result has no key "${upstreamKey}", which \`from.${key}\` names`,
      };
    }
    filled[key] = result[upstreamKey];
  }

  return { ok: true, filled, used: { receipt: receiptId, step: receipt.step, result: receipt.result } };
}
