import type { Pickle, PickleStep } from "@cucumber/messages";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { isStep, type Step } from "../step/define-step.js";
import type { CheckedPattern } from "./binding-check.js";
import { matchPickleStepText } from "./feature-check.js";

// Responsibility: docs/spec.md "Chaining steps"' "Declaring `from` buys a
// check that costs nothing to be sure about" paragraph, made real, for one
// already-selected pickle — for every typed step bound in it that declares
// `from`, whether each declared key's upstream step is bound *earlier* in
// this same pickle (Background included: @cucumber/gherkin has already
// merged it into `pickle.steps` by the time anything reaches this function,
// so there is nothing here to special-case). One function, called from both
// `nuka check` (src/check/feature-check.ts, once per pickle in every
// feature) and `nuka run`'s pre-execution guard (src/run/run-scenario.ts,
// once for the one pickle about to run) — m6b-from-check task spec, item 3:
// two separate judgments of the same fact would drift out of sync with each
// other over time.
//
// Zero false positives is the whole design point (m6b-from-check task spec,
// "制約・前提"): an issue is only ever raised for a *required* key with no
// earlier binding, because that is the one case docs/spec.md can promise
// "this run would fail args validation with certainty". An *optional* key
// with no earlier binding stays silent on purpose — the schema itself
// already says the value may be absent, and flagging a contract being
// honored would be noise in the one place noise is fatal (docs/spec.md
// "Chaining steps").
//
// Reuses src/check/feature-check.ts's own `matchPickleStepText`/
// `CheckedPattern` (m6b-from-check task spec, "実装上の再利用") to resolve
// each pickle step's own bound name — the exact same resolution undefined-
// step/ambiguous-step detection already does, never a second implementation
// of it. A line that resolves to zero or two-or-more candidates is left
// alone here (its own undefined-step/ambiguous-step issue is feature-
// check.ts's business, not this module's) — and, deliberately, an upstream
// that only ever shows up on such a line is therefore treated as unbound:
// that is not a false negative, since an ambiguous/undefined line never
// actually produces that upstream's result at run time either.
//
// An upstream that isn't a valid, registered `Step` at all is left alone
// here too: that structural fact is m6a-from-core's own check
// (src/step/validate-from.ts's `validateStepFrom`), reused rather than
// re-derived (m6b-from-check task spec: "判定を書き直さない") — without a
// name to look for among this pickle's own resolved steps, there is nothing
// this module could safely conclude either way, so it stays silent and
// leaves that finding to `validateStepFrom`'s own caller.
//
// A key a pattern capture fills always wins (checked first, via this
// occurrence's own `matched.captures` — never every occurrence of the
// pattern, so the same step can take a key from Gherkin in one scenario and
// from `from` in another), and so does the one key this pickle step's own
// table/docstring attachment resolves to filling: src/run/match-step.ts's
// `bindStepArgs` fills that same "exactly one unconsumed required key" from
// the attachment before `from` injection ever runs (src/run/run-
// scenario.ts's own `injectFrom`), so treating that key as still needing an
// upstream here would itself be a false positive — the attachment, not
// `from`, is what actually supplies it at run time. The computation below
// mirrors src/check/feature-check.ts's own inline copy of that same
// "exactly one unconsumed required key" rule exactly, rather than
// approximating it.

export interface FromOrderIssue {
  /** 0-based index into `pickle.steps` — the consuming line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly key: string;
  readonly upstreamStepName: string;
  /** "missing": the upstream never resolves to exactly one step anywhere in
   * this pickle. "later": it does, but never before `stepIndex`. Two
   * distinct causes, one issue code (m6b-from-check task spec: "code は分
   * けなくてよい") — the message is what tells them apart. */
  readonly reason: "missing" | "later";
  readonly message: string;
}

function fromOrderMessage(
  stepName: string,
  key: string,
  upstreamStepName: string,
  reason: "missing" | "later",
): string {
  const detail =
    reason === "missing"
      ? `"${upstreamStepName}" is never bound anywhere in this scenario`
      : `"${upstreamStepName}" is bound in this scenario, but only at or after this line, never before it`;
  return (
    `Step "${stepName}"'s from.${key} needs step "${upstreamStepName}" to have already run earlier ` +
    `in this scenario, but ${detail} — this line would fail args validation with certainty`
  );
}

/**
 * The one required, uncaptured args key this pickle step's own table/
 * docstring attachment (if any) resolves to filling — `undefined` when there
 * is no attachment, no object shape to check it against, or zero/several
 * such keys (in which case binding itself fails for an unrelated reason,
 * src/run/match-step.ts's own `bindStepArgs`; nothing here needs to say so a
 * second time).
 */
function attachmentFilledKey(
  pickleStep: PickleStep,
  consumedByCapture: ReadonlySet<string>,
  argsShape: ReturnType<typeof asObjectShape>,
): string | undefined {
  const attachment = pickleStep.argument;
  const hasAttachment = attachment?.dataTable !== undefined || attachment?.docString !== undefined;
  if (!hasAttachment || argsShape === undefined) {
    return undefined;
  }
  const unconsumedRequired = Object.entries(argsShape)
    .filter(([shapeKey, fieldSchema]) => !consumedByCapture.has(shapeKey) && isRequiredField(fieldSchema))
    .map(([shapeKey]) => shapeKey);
  return unconsumedRequired.length === 1 ? unconsumedRequired[0] : undefined;
}

export function checkFromOrder(
  pickle: Pickle,
  vocabulary: Vocabulary,
  patterns: readonly CheckedPattern[],
): readonly FromOrderIssue[] {
  const issues: FromOrderIssue[] = [];

  // One resolution pass over this pickle's own steps, reused for every
  // `from` key on every step below (m6b-from-check task spec: patterns are
  // matched here, never rebuilt).
  const matches = pickle.steps.map((step) => matchPickleStepText(step.text, patterns));
  const resolvedNames = matches.map((match) => (match.stepNames.length === 1 ? match.stepNames[0] : undefined));

  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      stepNameOf.set(entry.step, entry.name);
    }
  }

  pickle.steps.forEach((pickleStep, stepIndex) => {
    const stepName = resolvedNames[stepIndex];
    if (stepName === undefined) {
      return; // Undefined/ambiguous at this line — feature-check.ts's own concern.
    }
    const entry = vocabulary.get(stepName);
    if (entry === undefined || entry.kind !== "typed") {
      return; // Compat has no `from` at all.
    }
    const fromEntries = Object.entries(entry.step.from);
    if (fromEntries.length === 0) {
      return;
    }

    const argsShape = asObjectShape(entry.step.args);
    const matched = matches[stepIndex]!.matched;
    const consumedByCapture = new Set(matched?.captures.map((capture) => capture.key) ?? []);
    const attachmentFillsKey = attachmentFilledKey(pickleStep, consumedByCapture, argsShape);

    for (const [key, entryTuple] of fromEntries) {
      if (consumedByCapture.has(key) || key === attachmentFillsKey) {
        continue; // A pattern capture or the table/docstring already wins this key.
      }

      const fieldSchema = argsShape?.[key];
      if (fieldSchema === undefined) {
        // `args` isn't an object schema, or `key` isn't one of its own keys
        // — both are m6a-from-core's own structural findings
        // (`validateStepFrom`), not this module's to re-derive.
        continue;
      }
      if (!isRequiredField(fieldSchema)) {
        continue; // Optional: silent by design (m6b-from-check task spec).
      }

      const [upstream] = entryTuple;
      const upstreamStepName = isStep(upstream) ? stepNameOf.get(upstream) : undefined;
      if (upstreamStepName === undefined) {
        // Not a valid, registered Step — m6a-from-core's `validateStepFrom`
        // already covers this; there is no name here to check an order
        // against.
        continue;
      }

      let boundBefore = false;
      let boundAnywhere = false;
      for (let otherIndex = 0; otherIndex < resolvedNames.length; otherIndex += 1) {
        if (resolvedNames[otherIndex] === upstreamStepName) {
          boundAnywhere = true;
          if (otherIndex < stepIndex) {
            boundBefore = true;
            break;
          }
        }
      }
      if (boundBefore) {
        continue;
      }

      const reason: "missing" | "later" = boundAnywhere ? "later" : "missing";
      issues.push({
        stepIndex,
        stepName,
        key,
        upstreamStepName,
        reason,
        message: fromOrderMessage(stepName, key, upstreamStepName, reason),
      });
    }
  });

  return issues;
}
