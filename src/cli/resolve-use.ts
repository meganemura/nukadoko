import type { UsedEntry } from "../context/used.js";
import type { Receipt } from "../receipt/types.js";
import type { Step } from "../step/define-step.js";

// Responsibility: `nuka do --use <receipt-id>`'s own lookup (m6c-do-use task
// spec; docs/spec.md "Single steps (the agent path)", the `--use` paragraph)
// — turns one receipt id into whichever of the step actually being run's own
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
  /** The `{ receipt, step }` shape the `used` collector (src/context/used.ts)
   * already records — handed straight to `StepContextHandle.recordUsed`
   * (m6a-from-core task spec's own collector; this task's spec, item 6: no
   * second recording path) once the caller decides at least one of
   * `filled`'s keys actually landed. */
  readonly used: UsedEntry;
}

export type ResolveUseResult = ResolveUseError | ResolveUseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves one `--use <receiptId>` against `step`'s own `from` declaration
 * (this task's spec, items 1-4). Checked in the order the task spec's own
 * error list states: unknown id, a non-`"ok"` receipt, a receipt whose step
 * names none of `step.from`'s upstreams, then — per matching entry — a
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
      message: `--use ${receiptId}: this receipt's status is "${receipt.status}", not "ok" — a failed execution has no validated result to read`,
    };
  }

  // Entries (plural on purpose — docs/spec.md's own wording): a single
  // upstream step can be named by more than one of this step's `from` keys
  // (this task's spec, item 3), and one matching receipt fills all of them.
  const matches = Object.entries(step.from).filter(
    ([, [upstream]]) => stepNameOf.get(upstream) === receipt.step,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      message: `--use ${receiptId}: its step "${receipt.step}" is not named by any of this step's \`from\` entries`,
    };
  }

  const result = receipt.result;
  const filled: Record<string, unknown> = {};
  for (const [key, [, upstreamKey]] of matches) {
    if (!isRecord(result) || !(upstreamKey in result)) {
      return {
        ok: false,
        message: `--use ${receiptId}: its result has no key "${upstreamKey}", which \`from.${key}\` names`,
      };
    }
    filled[key] = result[upstreamKey];
  }

  return { ok: true, filled, used: { receipt: receiptId, step: receipt.step } };
}
