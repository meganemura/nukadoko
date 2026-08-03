import { asObjectShape } from "../binding/schema-shape.js";
import { isStep, type Step } from "./define-step.js";

// Responsibility: the runtime half of `from`'s three checks (m6a-from-core
// task spec, item 3; docs/spec.md "Chaining steps") — whether the upstream a
// `from` entry names is even a usable, registered `Step` at all, whether its
// `returns` actually has the key named, and whether this step's own `args`
// actually has the key `from` is trying to fill. Deliberately *not* about
// whether a given scenario's own step order actually satisfies the
// dependency (docs/spec.md "Chaining steps"' "Declaring `from` buys a check
// that costs nothing to be sure about" paragraph) — that question needs a
// pickle's own step sequence, which this function never sees, and is m6b's
// job (`nuka check`'s scenario-order check, `nuka run`'s pre-execution
// guard). This one is structural and scenario-independent: it holds or fails
// the same way for every occurrence of the step, in every scenario, so it is
// checked once, not per scenario.
//
// A pure function returning issues, not throwing and not printing anything
// (this task's spec, item 3): `nuka do`'s own fatal wiring (src/cli/do.ts)
// converts a non-empty result into the same stderr+exit-1 path
// ConfigError/DuplicateStepError already use; m6b's `nuka check` is expected
// to call this same function per typed vocabulary entry and fold the results
// into its own report (`CheckIssue`, src/check/types.ts) — this module knows
// nothing about that shape on purpose, so it stays reusable by a reporting
// context very different from a fatal CLI exit.

export interface FromIssue {
  /** The step declaring the broken `from` entry (a vocabulary name, e.g.
   * "archive-project" — not a file path; the same name `nuka steps`/`nuka
   * describe` use). */
  readonly step: string;
  /** The `from` key this issue is about (`from`'s own key, i.e. the args key
   * being filled — not the upstream's returns key). */
  readonly key: string;
  readonly message: string;
}

/**
 * Builds the "is this Step object one discovery actually put in the
 * vocabulary" predicate both `ctx.resultOf`'s unregistered-Step throw
 * (src/context/create-context.ts) and this file's own registration check
 * need (m6a-from-core task spec, items 3-4, 6) — one `Set`, built once from
 * whichever vocabulary the caller already has (`nuka do`'s single lookup,
 * `nuka run`'s per-pickle `vocabulary` option), so a dynamic-import-produced
 * Step that never went through discovery is never accidentally treated as
 * registered just because it happens to structurally resemble one.
 */
export function registeredStepPredicate(steps: Iterable<Step>): (candidate: Step) => boolean {
  const registered = new Set<Step>(steps);
  return (candidate: Step): boolean => registered.has(candidate);
}

/**
 * Validates one step's own `from` declaration in isolation (this task's spec,
 * item 3's four bullets): upstream is a `Step` at all, upstream is
 * registered, upstream's `returns` is an object schema with the named key,
 * and this step's own `args` is an object schema with the `from` key itself.
 * Returns every issue found; `[]` when `step.from` is empty or every entry
 * checks out. `isRegistered` is `registeredStepPredicate`'s own return value
 * — passed in, not built here, so a caller validating many steps against the
 * same vocabulary builds the `Set` once, not once per step.
 */
export function validateStepFrom(
  stepName: string,
  step: Step,
  isRegistered: (candidate: Step) => boolean,
): FromIssue[] {
  const issues: FromIssue[] = [];
  const argsShape = asObjectShape(step.args);

  for (const [key, entry] of Object.entries(step.from)) {
    const [upstream, upstreamKey] = entry;

    if (!isStep(upstream)) {
      issues.push({
        step: stepName,
        key,
        message: `from.${key} names something that is not a Step`,
      });
    } else if (!isRegistered(upstream)) {
      issues.push({
        step: stepName,
        key,
        message:
          `from.${key} names a Step discovery never registered — most likely it was reached ` +
          `through a different \`await import()\` than the one discovery used, producing a ` +
          `distinct module instance (docs/spec.md "Chaining steps")`,
      });
    } else {
      const returnsShape = asObjectShape(upstream.returns);
      if (returnsShape === undefined) {
        issues.push({
          step: stepName,
          key,
          message: `from.${key}'s upstream step's returns is not an object schema, so key "${upstreamKey}" cannot be read from it`,
        });
      } else if (!(upstreamKey in returnsShape)) {
        issues.push({
          step: stepName,
          key,
          message: `from.${key} names key "${upstreamKey}", which is not one of the upstream step's returns keys`,
        });
      }
    }

    if (argsShape === undefined) {
      issues.push({
        step: stepName,
        key,
        message: `this step's args is not an object schema, so from cannot fill key "${key}"`,
      });
    } else if (!(key in argsShape)) {
      issues.push({
        step: stepName,
        key,
        message: `from declares key "${key}", which is not one of this step's own args keys`,
      });
    }
  }

  return issues;
}

/** Renders `issues` as one line per issue, `"<step>: <message>"` — `nuka
 * do`'s own fatal-message rendering (src/cli/do.ts); kept here so a second
 * caller with the same "print each issue" need doesn't drift from this
 * wording. `nuka check`'s own report (m6b) is expected to keep the
 * structured `FromIssue[]` instead of this flattened text. */
export function formatFromIssues(issues: readonly FromIssue[]): string {
  return issues.map((issue) => `${issue.step}: ${issue.message}`).join("\n");
}
