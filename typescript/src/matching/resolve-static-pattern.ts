import { CucumberExpression } from "@cucumber/cucumber-expressions";
import { buildExpression } from "../binding/expression.js";
import { createParameterTypeRegistry } from "../binding/registry.js";

// Responsibility: resolve one committed `pattern` entry into a plain
// text-match predicate, for a caller outside this package that only needs
// "does this pattern match that text" and nothing else (an editor extension
// deciding which step a Gherkin line binds to, for example). This module
// calls the same seam src/run/match-step.ts already calls
// (src/binding/expression.ts's `buildExpression`, src/binding/registry.ts's
// `createParameterTypeRegistry`) rather than building a second matching
// implementation, so a caller of this module and `nuka run` can never
// disagree about what a pattern matches.
//
// Registry is always `createParameterTypeRegistry([])`, built-ins only: a
// caller outside this package's own process has no way to run a workspace's
// `nukadoko.config.ts` (`config.parameterTypes`) or its compat
// `defineParameterType` calls without importing and executing that
// workspace's code, which is out of scope for a purely static resolution. A
// pattern that only matches through a custom parameter type resolves to
// `ok: false`, correctly: this module cannot know what that type matches
// without running code this package does not own.

export type StaticPatternInput =
  | { readonly kind: "typed"; readonly pattern: string }
  | { readonly kind: "compat"; readonly pattern: string | RegExp };

export type StaticPatternResolution =
  | { readonly ok: true; readonly matches: (text: string) => boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Never throws: every error `buildExpression`/`CucumberExpression` can raise
 * (a capture-naming error from `stripCaptureNames`, cucumber-expressions' own
 * `UndefinedParameterTypeError` for an unregistered type name) is caught and
 * turned into `{ ok: false, reason }` carrying that error's own message, so a
 * caller can always tell *why* a pattern didn't resolve rather than getting
 * a silent `false`.
 */
export function resolveStaticPattern(input: StaticPatternInput): StaticPatternResolution {
  if (input.kind === "typed") {
    return resolveExpression(() => buildExpression(input.pattern, createParameterTypeRegistry([])).expression);
  }

  // input.kind === "compat"
  if (input.pattern instanceof RegExp) {
    // No building step, same as src/run/match-step.ts's own regexp branch: a
    // fresh RegExp per call keeps a `/g`/`/y`-flagged pattern's `lastIndex`
    // from carrying state across the many `matches()` calls a caller makes
    // over this resolution's lifetime (the same state src/check/feature-
    // check.ts's own `checkedPatternMatches` guards against).
    const { source, flags } = input.pattern;
    return {
      ok: true,
      matches: (text: string) => new RegExp(source, flags).test(text),
    };
  }

  // A compat string pattern is unmodified cucumber-expressions syntax, not a
  // nukadoko `{key:type}` pattern, so it skips `stripCaptureNames`/
  // `buildExpression` entirely, same as src/run/match-step.ts's own
  // compat-string branch (see that module's header for why: the migration
  // door's promise is unmodified cucumber-expressions syntax).
  const pattern = input.pattern;
  return resolveExpression(() => new CucumberExpression(pattern, createParameterTypeRegistry([])));
}

function resolveExpression(build: () => CucumberExpression): StaticPatternResolution {
  try {
    const expression = build();
    return { ok: true, matches: (text: string) => expression.match(text) !== null };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}
