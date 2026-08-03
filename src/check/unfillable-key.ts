import type { Pickle } from "@cucumber/messages";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { CheckedPattern } from "./binding-check.js";
import { attachmentFilledKey } from "./from-order.js";
import { matchPickleStepText } from "./feature-check.js";

// Responsibility: docs/spec.md "Typed steps"' args/returns paragraph
// ("statically checkable in both directions") made real for the direction
// that was, until this task, never checked — a required args key that
// nothing on a given pickle line could possibly fill. There are exactly
// four ways a required key ever gets filled at run time (docs/spec.md
// "Typed steps"/"Chaining steps"): a named capture in the matched pattern,
// the one "exactly one unconsumed required key" table/docstring attachment
// rule, a declared `from`, or the key being optional to begin with. When
// none of those four applies to a given (step, key) pair, that line is
// certain to fail args validation the moment it runs — knowable without
// ever opening a browser.
//
// Zero false positives is the whole design point (m7b-unfillable-key task
// spec, "制約・前提"), so this module only ever answers the question for a
// line it can resolve with certainty: exactly one *typed* step match (an
// undefined/ambiguous line is feature-check.ts's own concern, and a compat
// match has no args schema to check at all) whose `args` is a `z.object`
// (anything else has no keys to check, same scope note src/check/binding-
// check.ts's own `args-not-object` finding already uses). A key named in
// `from` is deliberately left alone here even when that declaration is
// itself broken or unreachable — whether it actually supplies the value in
// time is src/check/from-order.ts's own judgment (and, before that, src/
// step/validate-from.ts's structural one), and this module must not repeat
// either finding under a third code.
//
// Reuses, never re-derives: `matchPickleStepText` (src/check/feature-
// check.ts) for the same per-line pattern resolution every other check in
// this package already shares, and `attachmentFilledKey` (src/check/from-
// order.ts, exported for this file) for the table/docstring "exactly one
// unconsumed required key" rule — the same computation src/check/feature-
// check.ts's own `table-docstring-key-mismatch` inline copy already applies,
// reused rather than approximated a third time (this task's spec: "二つ目
// の計算を作らない").
//
// One function, called from both `nuka check` (src/check/feature-check.ts,
// once per pickle) and `nuka run`'s pre-execution guard (src/run/run-
// scenario.ts, right alongside its existing `checkFromOrder` call) — the
// same "one judgment, two call sites" shape src/check/from-order.ts's own
// header already established for the exact same reason: two separate
// implementations of the same fact would drift.

export interface UnfillableKeyIssue {
  /** 0-based index into `pickle.steps` — the line with the unfillable key. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly key: string;
  readonly message: string;
}

/** Names the step and key, and every one of the four remedies this task's
 * spec requires — there is no fifth way to fill a required args key, so
 * enumerating exactly these four is a fact, not a guess. */
function unfillableKeyMessage(stepName: string, key: string): string {
  return (
    `Step "${stepName}"'s args key "${key}" is required, but nothing on this line can fill it: ` +
    `no named capture in the matched pattern binds it, there is no table/docstring attachment ` +
    `that resolves to filling it, and it has no declared from.${key} — this line would fail args ` +
    `validation with certainty. Fix one of: add a named capture for "${key}" to the step's ` +
    `pattern; attach a table/docstring that fills it; declare from.${key}; or make "${key}" ` +
    `optional in the step's args schema`
  );
}

export function checkUnfillableKeys(
  pickle: Pickle,
  vocabulary: Vocabulary,
  patterns: readonly CheckedPattern[],
): readonly UnfillableKeyIssue[] {
  const issues: UnfillableKeyIssue[] = [];

  pickle.steps.forEach((pickleStep, stepIndex) => {
    const { stepNames, matched } = matchPickleStepText(pickleStep.text, patterns);
    if (stepNames.length !== 1) {
      return; // Undefined/ambiguous at this line — feature-check.ts's own concern.
    }
    const stepName = stepNames[0]!;
    const entry = vocabulary.get(stepName);
    if (entry === undefined || entry.kind !== "typed") {
      return; // Compat has no args schema to check keys against.
    }
    const argsShape = asObjectShape(entry.step.args);
    if (argsShape === undefined) {
      return; // Not a z.object — binding-check.ts's own `args-not-object` finding.
    }

    // Safe: `stepNames.length === 1` above is exactly the condition
    // `matchPickleStepText` sets `matched` under.
    const consumedByCapture = new Set(matched!.captures.map((capture) => capture.key));
    const attachmentFillsKey = attachmentFilledKey(pickleStep, consumedByCapture, argsShape);

    // An attachment that does *not* resolve to filling exactly one key (0 or
    // 2+ still-uncaptured required keys) is already `table-docstring-key-
    // mismatch`'s own finding (src/check/feature-check.ts) — and, at run
    // time, src/run/match-step.ts's `bindStepArgs` fails to bind *before*
    // `from` injection ever runs, unconditionally, whether or not any of
    // those keys separately declares a `from` (this module's own reuse of
    // `attachmentFilledKey` can't tell "declares from" apart from "doesn't"
    // here — bindStepArgs never looks at `from` either). Every required key
    // on this line is left alone rather than risk reporting the same
    // certain failure under a second code, or — for src/run/run-scenario.ts's
    // shared guard — pre-empting a binding failure that must still produce a
    // real (non-null) receipt, exactly as it always has.
    const attachment = pickleStep.argument;
    const hasAttachment = attachment?.dataTable !== undefined || attachment?.docString !== undefined;
    if (hasAttachment && attachmentFillsKey === undefined) {
      return;
    }

    for (const [key, fieldSchema] of Object.entries(argsShape)) {
      if (!isRequiredField(fieldSchema)) {
        continue; // Optional — the schema itself says absent is fine.
      }
      if (consumedByCapture.has(key) || key === attachmentFillsKey) {
        continue; // A pattern capture or the table/docstring already fills this key.
      }
      if (Object.prototype.hasOwnProperty.call(entry.step.from, key)) {
        // Declared — whether it actually resolves in time is from-order.ts's
        // own judgment (and validate-from.ts's structural one before that);
        // reporting here too would be the same finding under a second code.
        continue;
      }
      issues.push({
        stepIndex,
        stepName,
        key,
        message: unfillableKeyMessage(stepName, key),
      });
    }
  });

  return issues;
}
