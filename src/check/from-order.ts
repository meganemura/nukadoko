import type { Pickle, PickleStep } from "@cucumber/messages";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { fromCandidates, isStep, type Step } from "../step/define-step.js";
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
//
// A key naming several candidate producers (m7a-from-alternatives task spec,
// item 3; docs/spec.md "Chaining steps": "A key may name more than one
// possible producer") counts how many of its *named* candidates
// (`fromCandidates`, skipping any that isn't even a valid registered `Step`
// — validate-from.ts's own structural finding, not re-derived here) are
// bound earlier than this line: exactly one is the only silent outcome for a
// required key, zero is the pre-existing "missing"/"later" error, and two or
// more is a new error that fires whether the key is required or optional —
// docs/spec.md's own reasoning: a schema can say a value may be absent, but
// no schema asks for "either of these two, and the feature file cannot tell
// you which." This is deliberately a *count*, never a rule that picks a
// winner among several bound candidates (this task's spec: "優先順位を作ら
// ない" — declaration order, most-recent, first-found are all rejected on
// purpose); two-or-more bound early is always reported, never resolved.

export interface FromOrderIssue {
  /** 0-based index into `pickle.steps` — the consuming line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly key: string;
  /** The candidate producer step name(s) this issue is about — one name for
   * the "zero bound" case (unchanged from before m7a-from-alternatives; a
   * key with several candidates still gets one name per candidate,
   * enumerated in `message`), two or more for the new "two-or-more bound"
   * conflict this task adds. */
  readonly upstreamStepNames: readonly string[];
  /** "missing": none of this key's candidates ever resolves to exactly one
   * step anywhere in this pickle. "later": at least one does, but never
   * before `stepIndex`. "ambiguous": two or more candidates are
   * simultaneously bound before `stepIndex` (m7a-from-alternatives task
   * spec, item 3) — an error independent of required/optional, unlike the
   * other two. Three distinct causes, one issue code (m6b-from-check task
   * spec: "code は分けなくてよい", extended by this task rather than
   * introducing a second code) — the message is what tells them apart. */
  readonly reason: "missing" | "later" | "ambiguous";
  readonly message: string;
}

/** One candidate's own order status against the consuming line — computed
 * once per named candidate and shared by both the "zero bound" and
 * "two-or-more bound" message builders below, so the two never derive
 * slightly different facts about the same candidate. */
interface CandidateStatus {
  readonly name: string;
  readonly boundBefore: boolean;
  readonly boundAnywhere: boolean;
}

/** The "zero of this key's candidates bound earlier" message — required
 * key, and no candidate is ready. For a single-candidate key this is byte-
 * for-byte what m6b-from-check always produced (this task's spec:
 * backward compatible, no rewording an existing, working message); a key
 * with several candidates instead enumerates every candidate's own status,
 * since there is no one candidate left to single out. */
function fromOrderMissingMessage(stepName: string, key: string, candidates: readonly CandidateStatus[]): string {
  if (candidates.length === 1) {
    const [only] = candidates;
    const detail = only!.boundAnywhere
      ? `"${only!.name}" is bound in this scenario, but only at or after this line, never before it`
      : `"${only!.name}" is never bound anywhere in this scenario`;
    return (
      `Step "${stepName}"'s from.${key} needs step "${only!.name}" to have already run earlier ` +
      `in this scenario, but ${detail} — this line would fail args validation with certainty`
    );
  }
  const names = candidates.map((c) => `"${c.name}"`).join(", ");
  const detail = candidates
    .map((c) =>
      c.boundAnywhere
        ? `"${c.name}" is bound only at or after this line, never before it`
        : `"${c.name}" is never bound anywhere in this scenario`,
    )
    .join("; ");
  return (
    `Step "${stepName}"'s from.${key} needs exactly one of its candidate producers (${names}) to have ` +
    `already run earlier in this scenario, but none has — ${detail} — this line would fail args ` +
    `validation with certainty`
  );
}

/** The "two or more of this key's candidates bound earlier" message —
 * new in m7a-from-alternatives, since a single-candidate key can never reach
 * this state (docs/spec.md "Chaining steps": listing candidates says they
 * are mutually exclusive, so two being simultaneously ready is exactly the
 * ambiguity a schema cannot express and the feature file must resolve, not
 * this tool). */
function fromOrderAmbiguousMessage(stepName: string, key: string, names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`).join(", ");
  return (
    `Step "${stepName}"'s from.${key} has more than one of its candidate producers bound earlier in ` +
    `this scenario (${quoted}) — from's candidates are mutually exclusive by design (docs/spec.md ` +
    `"Chaining steps"), so the feature file, not the tool, must make exactly one of them win`
  );
}

/**
 * The one required, uncaptured args key this pickle step's own table/
 * docstring attachment (if any) resolves to filling — `undefined` when there
 * is no attachment, no object shape to check it against, or zero/several
 * such keys (in which case binding itself fails for an unrelated reason,
 * src/run/match-step.ts's own `bindStepArgs`; nothing here needs to say so a
 * second time).
 *
 * Exported (m7b-unfillable-key task spec) so ./unfillable-key.ts's own check
 * asks this exact same question rather than growing a third copy of "exactly
 * one unconsumed required key" alongside this function and
 * src/check/feature-check.ts's own inline one.
 */
export function attachmentFilledKey(
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

    for (const [key, entryValue] of fromEntries) {
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
      // Required/optional decides *whether* zero-bound is an error below
      // (m6b-from-check task spec, unchanged); it does not gate the
      // two-or-more-bound check (m7a-from-alternatives task spec, item 3:
      // "required / optional によらず error").
      const required = isRequiredField(fieldSchema);

      // Every *named* candidate — `fromCandidates` normalizes the single- and
      // multi-candidate shapes uniformly, and a candidate whose upstream
      // isn't even a valid, registered `Step` is left out of the count
      // entirely (that structural fact is validate-from.ts's own finding,
      // not re-derived here — same as before m7a-from-alternatives, just
      // now per candidate instead of per key).
      const named: CandidateStatus[] = [];
      for (const [upstream] of fromCandidates(entryValue)) {
        const name = isStep(upstream) ? stepNameOf.get(upstream) : undefined;
        if (name === undefined) {
          continue;
        }
        let boundBefore = false;
        let boundAnywhere = false;
        for (let otherIndex = 0; otherIndex < resolvedNames.length; otherIndex += 1) {
          if (resolvedNames[otherIndex] === name) {
            boundAnywhere = true;
            if (otherIndex < stepIndex) {
              boundBefore = true;
              break;
            }
          }
        }
        named.push({ name, boundBefore, boundAnywhere });
      }
      if (named.length === 0) {
        continue; // No candidate has a name to check an order against.
      }

      const boundBefore = named.filter((candidate) => candidate.boundBefore);
      if (boundBefore.length === 1) {
        continue; // Exactly one candidate ready — the one silent outcome.
      }
      if (boundBefore.length >= 2) {
        const names = boundBefore.map((candidate) => candidate.name);
        issues.push({
          stepIndex,
          stepName,
          key,
          upstreamStepNames: names,
          reason: "ambiguous",
          message: fromOrderAmbiguousMessage(stepName, key, names),
        });
        continue;
      }
      // boundBefore.length === 0 from here.
      if (!required) {
        continue; // Optional, none bound: silent by design (m6b-from-check task spec).
      }
      issues.push({
        stepIndex,
        stepName,
        key,
        upstreamStepNames: named.map((candidate) => candidate.name),
        reason: named.every((candidate) => !candidate.boundAnywhere) ? "missing" : "later",
        message: fromOrderMissingMessage(stepName, key, named),
      });
    }
  });

  return issues;
}
