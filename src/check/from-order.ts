import type { Pickle, PickleStep } from "@cucumber/messages";
import { asObjectShape, isRequiredField, unconsumedRequiredKeys } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { isStep, tryFromCandidates, type Step } from "../step/define-step.js";
import type { StepTextMatcher } from "./feature-check.js";

// Responsibility: docs/spec.md "Chaining steps"' "Declaring `from` buys a
// check that costs nothing to be sure about" paragraph, made real, for one
// already-selected pickle — for every typed step bound in it that declares
// `from`, whether each declared key's upstream step is bound *earlier* in
// this same pickle (Background included: @cucumber/gherkin has already
// merged it into `pickle.steps` by the time anything reaches this function,
// so there is nothing here to special-case). One function, called from both
// `nuka check` (src/check/feature-check.ts, once per pickle in every
// feature) and `nuka run`'s pre-execution guard (src/run/run-scenario.ts,
// once for the one pickle about to run) — otherwise
// two separate judgments of the same fact would drift out of sync with each
// other over time.
//
// Zero false positives is the whole design point: an issue is only ever raised for a *required* key with no
// earlier binding, because that is the one case docs/spec.md can promise
// "this run would fail args validation with certainty". An *optional* key
// with no earlier binding stays silent on purpose — the schema itself
// already says the value may be absent, and flagging a contract being
// honored would be noise in the one place noise is fatal (docs/spec.md
// "Chaining steps").
//
// Reuses src/check/feature-check.ts's own `StepTextMatcher` to resolve
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
// here too: that structural fact is already
// src/step/validate-from.ts's own check (`validateStepFrom`), reused rather than
// re-derived — without a
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
// is the shared `unconsumedRequiredKeys` rule, not an approximation of it.
//
// A key naming several candidate producers (docs/spec.md "Chaining steps":
// "A key may name more than one
// possible producer") counts how many of its *named* candidates
// (`fromCandidates`, skipping any that isn't even a valid registered `Step`
// — validate-from.ts's own structural finding, not re-derived here) are
// bound earlier than this line: exactly one is the only silent outcome for a
// required key, zero is the pre-existing "missing"/"later" error, and two or
// more is a new error that fires whether the key is required or optional —
// docs/spec.md's own reasoning: a schema can say a value may be absent, but
// no schema asks for "either of these two, and the feature file cannot tell
// you which." This is deliberately a *count*, never a rule that picks a
// winner among several bound candidates (declaration order, most-recent,
// first-found are all rejected on
// purpose); two-or-more bound early is always reported, never resolved.

export interface FromOrderIssue {
  /** 0-based index into `pickle.steps` — the consuming line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly message: string;
  readonly key: string;
  /** "missing": no candidate ran earlier; `candidates` is every named one.
   * "ambiguous": two or more ran earlier; `candidates` is those. */
  readonly kind: "missing" | "ambiguous";
  readonly candidates: readonly string[];
  /** Indexes of earlier lines no step matches. Such a line is often the
   * producer the author meant, written before its step, and nothing can
   * tell from here whether it is, so the do line names it as a condition. */
  readonly undefinedBefore: readonly number[];
}

export interface FromOrderLine {
  readonly line: number | undefined;
  readonly text: string;
}

function quotedNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/** The do line for one issue. Each sentence either names a change that
 * resolves the issue as stated, or is conditional on a fact only the author
 * knows (which earlier line is meant to produce the key). Removing the from
 * entry is not offered: the key stays required, and another scenario may
 * depend on the producer it names. */
export function fromOrderDo(issue: FromOrderIssue, steps: readonly FromOrderLine[]): string {
  const { key, stepName, candidates } = issue;
  if (issue.kind === "ambiguous") {
    return `Remove or move lines so that exactly one of steps ${quotedNames(candidates)} runs before this line.`;
  }
  const put =
    candidates.length === 1
      ? `Put a line that runs step "${candidates[0]}" earlier in the scenario`
      : `Put a line that runs exactly one of steps ${quotedNames(candidates)} earlier in the scenario`;
  const another = `list that step as another [step, "${key}"] candidate in from.${key} of step "${stepName}"`;
  if (issue.stepIndex === 0) {
    return `${put}.`;
  }
  if (issue.undefinedBefore.length === 0) {
    return `${put}. Or, if a step that an earlier line runs returns ${key}, ${another}.`;
  }
  const lines = issue.undefinedBefore.map((index) => {
    const step = steps[index];
    const at = step?.line === undefined ? "" : `line ${step.line} `;
    return `${at}"${step?.text ?? ""}"`;
  });
  const which =
    lines.length === 1
      ? `${lines[0]}, which no step matches yet,`
      : `one of ${lines.join(", ")}, which no step matches yet,`;
  const target = candidates.length === 1 ? `step "${candidates[0]}"` : `one of steps ${quotedNames(candidates)}`;
  // The rewording comes first: a line written just before its consumer
  // that matches nothing is most often the producer with a typo or a
  // drifted wording, and a new step that also returns the key would
  // duplicate the one the from entry already names.
  return (
    `${put}. If ${which} is meant to run ${target}, reword that line to match that step's pattern. ` +
    `If it should run a new step that produces ${key}, give that step ${key} in returns, and ` +
    `list it as another [step, "${key}"] candidate in from.${key} of step "${stepName}".`
  );
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
 * for-byte what this check always produced (kept backward compatible,
 * no rewording an existing, working message); a key
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
      `in this scenario, but ${detail}. This line would fail args validation with certainty`
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
    `already run earlier in this scenario, but none has: ${detail}. This line would fail args ` +
    `validation with certainty`
  );
}

/** The "two or more of this key's candidates bound earlier" message —
 * new, since a single-candidate key can never reach
 * this state (docs/spec.md "Chaining steps": listing candidates says they
 * are mutually exclusive, so two being simultaneously ready is exactly the
 * ambiguity a schema cannot express and the feature file must resolve, not
 * this tool). */
function fromOrderAmbiguousMessage(stepName: string, key: string, names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`).join(", ");
  return (
    `Step "${stepName}"'s from.${key} has more than one of its candidate producers bound earlier in ` +
    `this scenario (${quoted}): from's candidates are mutually exclusive by design (docs/spec.md ` +
    `"Chaining steps"), so the feature file, not the tool, must make exactly one of them win`
  );
}

/**
 * The one required, unspoken-for args key this pickle step's own table/
 * docstring attachment (if any) resolves to filling — `undefined` when there
 * is no attachment, no object shape to check it against, or zero/several
 * such keys (in which case binding itself fails for an unrelated reason,
 * src/run/match-step.ts's own `bindStepArgs`; nothing here needs to say so a
 * second time). `spokenFor` is the captured keys plus the keys the step
 * declares `from` for: a key `from` fills is never the attachment's, so a
 * step can take one key from an earlier step and the other from the
 * attachment on the same line, which is the shape a real suite wrote first.
 *
 * Exported so ./unfillable-key.ts's own check asks this exact same question.
 */
export function attachmentFilledKey(
  pickleStep: PickleStep,
  spokenFor: ReadonlySet<string>,
  argsShape: ReturnType<typeof asObjectShape>,
): string | undefined {
  const attachment = pickleStep.argument;
  const hasAttachment = attachment?.dataTable !== undefined || attachment?.docString !== undefined;
  if (!hasAttachment || argsShape === undefined) {
    return undefined;
  }
  const unconsumedRequired = unconsumedRequiredKeys(argsShape, spokenFor);
  return unconsumedRequired.length === 1 ? unconsumedRequired[0] : undefined;
}

export function checkFromOrder(
  pickle: Pickle,
  vocabulary: Vocabulary,
  match: StepTextMatcher,
): readonly FromOrderIssue[] {
  const issues: FromOrderIssue[] = [];

  // One resolution pass over this pickle's own steps, reused for every
  // `from` key on every step below.
  const matches = pickle.steps.map((step) => match(step.text));
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
    for (const [key, entryValue] of fromEntries) {
      if (consumedByCapture.has(key)) {
        continue; // A pattern capture already wins this key.
      }

      const fieldSchema = argsShape?.[key];
      if (fieldSchema === undefined) {
        // `args` isn't an object schema, or `key` isn't one of its own keys
        // — both are structural findings `validateStepFrom`
        // (src/step/validate-from.ts) already makes, not this module's to re-derive.
        continue;
      }
      // Required/optional decides *whether* zero-bound is an error below;
      // it does not gate the
      // two-or-more-bound check, which fires regardless of required/optional.
      const required = isRequiredField(fieldSchema);

      // Every *named* candidate — `tryFromCandidates` normalizes the single-
      // and multi-candidate shapes uniformly, and a candidate whose upstream
      // isn't even a valid, registered `Step` is left out of the count
      // entirely (that structural fact is validate-from.ts's own finding,
      // not re-derived here — same as before this per-candidate check
      // existed, just
      // now per candidate instead of per key). A structurally malformed
      // entry (`tryFromCandidates` returning `null`) is skipped the same
      // way, for the same reason: `validateStepFrom` already reports it as
      // `from-structural-violation`, the same "skip an edge a structural
      // finding already flagged" move src/check/parts-check.ts makes for
      // `part-structural-violation`.
      const named: CandidateStatus[] = [];
      const candidates = tryFromCandidates(entryValue);
      if (candidates === null) {
        continue;
      }
      for (const [upstream] of candidates) {
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
          message: fromOrderAmbiguousMessage(stepName, key, names),
          key,
          kind: "ambiguous",
          candidates: names,
          undefinedBefore: [],
        });
        continue;
      }
      // boundBefore.length === 0 from here.
      if (!required) {
        continue; // Optional, none bound: silent by design.
      }
      issues.push({
        stepIndex,
        stepName,
        message: fromOrderMissingMessage(stepName, key, named),
        key,
        kind: "missing",
        candidates: named.map((candidate) => candidate.name),
        undefinedBefore: matches
          .slice(0, stepIndex)
          .flatMap((earlier, index) => (earlier.stepNames.length === 0 ? [index] : [])),
      });
    }
  });

  return issues;
}
