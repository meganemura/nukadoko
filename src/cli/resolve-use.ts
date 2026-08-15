import type { UsedEntryWithResult } from "../context/used.js";
import type { StepRecord } from "../record/types.js";
import { fromCandidates, type Step } from "../step/define-step.js";

// Responsibility: `nuka do --use <record-id>`'s own lookup (docs/spec.md
// "Single steps (the agent path)", the `--use` paragraph) — turns one
// step record id into whichever of the step actually being run's own
// `from` keys that step record's result fills. A pure function around one
// step record id at a time, returning a result rather than throwing (same
// shape as src/step/validate-from.ts's `validateStepFrom`): `nuka do`'s own
// setup phase (src/cli/do.ts) is the thing that knows a non-`ok` result here
// means stderr + exit 1 with no step record written, not this module.
//
// `readStepRecord` and `stepNameOf` are both injected rather than built here
// — `readStepRecord` so a test can supply a fake without touching disk (the
// real one is src/record/read-step-record.ts's `readStepRecordById`, closed
// over `rootDir`/`config.stateDir` by the caller), and `stepNameOf` because
// it is the same "Step object -> the vocabulary name discovery registered it
// under" map `nuka do`'s own `isRegisteredStep` predicate is built from
// (one vocabulary walk, not two).
//
// A key naming several candidate producers matches this step record against
// every one of them via `fromCandidates`, exactly the way a
// single-candidate key already did — one step record can therefore still
// fill a key whose `from` lists several candidates, as long as its own step
// is one of them. What this module does *not* do is notice when two
// different `--use` values end up filling the same key from two *different*
// candidates — that cross-call comparison needs every `--use` value's own
// result side by side, which only this function's caller (src/cli/do.ts)
// has, and that is where the conflict check lives instead.

export interface ResolveUseError {
  readonly ok: false;
  readonly message: string;
}

export interface ResolveUseSuccess {
  readonly ok: true;
  /** Every args key this step record's `result` filled, keyed the same way
   * `step.from`'s own keys are — `nuka do`'s own caller still has to check
   * each key against `--args` before actually writing it in (`--args` wins
   * for a key it already set), so this is offered up unconditionally, not
   * pre-filtered. */
  readonly filled: Readonly<Record<string, unknown>>;
  /** The `{ record, step, result }` shape the `used` collector
   * (src/context/used.ts) already records — handed straight to
   * `StepContextHandle.recordUsed`, the sole path into that collector, once
   * the caller decides at least one of `filled`'s keys actually landed.
   * `result` is this upstream step record's own full validated result,
   * always populated here (this function only ever reaches this point for a
   * step record whose `status` is already checked `"ok"`, above); the
   * caller strips it back off for an "ok" step record of its own the same
   * way run-scenario.ts's `finishExecutedStep` does. */
  readonly used: UsedEntryWithResult;
}

export type ResolveUseResult = ResolveUseError | ResolveUseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves one `--use <recordId>` against `step`'s own `from` declaration.
 * Checked in this order: unknown id, a non-`"ok"` step record, a step
 * record whose step names none of `step.from`'s upstreams, then — per
 * matching entry — a `result` missing the key that entry names.
 */
export function resolveUse(
  recordId: string,
  step: Step,
  stepNameOf: ReadonlyMap<Step, string>,
  readStepRecord: (recordId: string) => StepRecord | null,
): ResolveUseResult {
  const stepRecord = readStepRecord(recordId);
  if (stepRecord === null) {
    return { ok: false, message: `--use ${recordId}: no such step record` };
  }

  if (stepRecord.status !== "ok") {
    return {
      ok: false,
      message: `--use ${recordId}: this step record's status is "${stepRecord.status}", not "ok". A failed execution has no validated result to read`,
    };
  }

  // Entries (plural on purpose — docs/spec.md's own wording): a single
  // upstream step can be named by more than one of this step's `from` keys,
  // and one matching step record fills all of them. Each key's own
  // candidates are checked individually via `fromCandidates`, so a key whose
  // `from` lists several producers still matches as long as one of them is
  // this step record's own step.
  const matches: Array<readonly [key: string, upstreamKey: string]> = [];
  for (const [key, entry] of Object.entries(step.from)) {
    for (const [upstream, upstreamKey] of fromCandidates(entry)) {
      if (stepNameOf.get(upstream) === stepRecord.step) {
        matches.push([key, upstreamKey]);
      }
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message: `--use ${recordId}: its step "${stepRecord.step}" is not named by any of this step's \`from\` entries`,
    };
  }

  const result = stepRecord.result;
  const filled: Record<string, unknown> = {};
  for (const [key, upstreamKey] of matches) {
    if (!isRecord(result) || !(upstreamKey in result)) {
      return {
        ok: false,
        message: `--use ${recordId}: its result has no key "${upstreamKey}", which \`from.${key}\` names`,
      };
    }
    filled[key] = result[upstreamKey];
  }

  return { ok: true, filled, used: { record: recordId, step: stepRecord.step, result: stepRecord.result } };
}
