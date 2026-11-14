import { isStep, type Step } from "./define-step.js";

// Responsibility: the structural half of `parts` (docs/spec.md "Parts") --
// whether each declared part is even a usable, registered `Step` at all.
// Same shape and same reason as src/step/validate-from.ts's own
// `validateStepFrom`: a pure function returning issues, never throwing and
// never printing, so `nuka check` (src/check/analyze.ts) can fold the
// result into its own report the same way it already does for `from`.
//
// Deliberately not about whether the calling step's own body actually calls
// every declared part -- docs/spec.md "Parts" rules that out by name ("A
// declared part the body never calls is reported by nothing, and that is
// deliberate"): the declaration names a `Step` object, not the identifier a
// body happens to bind it to, so deciding the two do not correspond would
// be a guess. And not about a cycle spanning several steps' own `parts`
// (src/check/parts-check.ts's `findPartCycles`) -- that is a property of
// the whole graph, not of one step's declaration read in isolation.
//
// Placed beside validate-from.ts/validate-fixtures.ts for the same "one
// step's own declaration, checked in isolation" shape those two already
// have, not because anything at run time shares this exact function today:
// unlike `from` (whose runtime half, ctx.resultOf, reuses nothing from
// validate-from.ts either, but whose *structural* check this module mirrors
// most closely), `ctx.call`'s own structural check
// (`caller.parts.includes(part)` + `isRegisteredStep(part)` in
// src/context/create-context.ts) is written inline, not routed through a
// shared function -- there is no `nuka do`/`nuka run` setup-phase call to
// this module the way validateStepFrom has. Kept anyway, in the same shape,
// so a future setup-phase check (the same kind `from`/fixtures already have)
// has a ready home instead of a reason to duplicate this logic.

export interface PartIssue {
  /** The step declaring the broken `parts` entry (a vocabulary name -- the
   * same name `nuka steps`/`nuka describe` use, not a file path). */
  readonly step: string;
  readonly message: string;
}

/**
 * Validates one step's own `parts` declaration in isolation: every entry
 * must be a `Step` object, and every `Step` must be one discovery actually
 * registered. `isRegistered` is the same predicate
 * `validateStepFrom`'s own `registeredStepPredicate` builds (src/step/
 * validate-from.ts) -- passed in, not built here, so a caller checking many
 * steps against the same vocabulary builds the underlying `Set` once.
 * Returns every issue found; `[]` when `step.parts` is empty or every entry
 * checks out.
 */
export function validateStepParts(
  stepName: string,
  step: Step,
  isRegistered: (candidate: Step) => boolean,
): PartIssue[] {
  const issues: PartIssue[] = [];

  step.parts.forEach((part, index) => {
    if (!isStep(part)) {
      issues.push({
        step: stepName,
        message: `parts[${index}] names something that is not a Step`,
      });
    } else if (!isRegistered(part)) {
      issues.push({
        step: stepName,
        message:
          `parts[${index}] names a Step discovery never registered. Most likely it was reached ` +
          `through a different \`await import()\` than the one discovery used, producing a ` +
          `distinct module instance (docs/spec.md "Parts")`,
      });
    }
  });

  return issues;
}
