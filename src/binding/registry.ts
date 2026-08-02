import { ParameterType, ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import type { ParameterTypeConfig } from "../config/schema.js";
import { ParameterTypeCollisionError } from "./parameter-type-errors.js";

// Responsibility: the one ParameterTypeRegistry `nuka check` and `nuka run`
// share. `new ParameterTypeRegistry()` already registers cucumber-
// expressions' own built-in types (int, float, word, string, the anonymous
// type, ...) in its constructor; this factory's other job is to layer
// `config.parameterTypes` (docs/spec.md config section) on top of that,
// registering each entry as a `ParameterType` with cucumber-expressions
// itself — the transformer is coercion, the registry does no interpretation
// of its own (m2pre-parameter-types task spec, decision 1).
//
// A name collision is checked before anything is registered with a name
// that collides with a built-in type — this project's own choice, not
// cucumber-expressions': `ParameterTypeRegistry.defineParameterType` would
// already throw its own `CucumberExpressionError` for the exact same
// situation, but with a message aimed at a library author, not a config
// author, and no stable type to `instanceof` on. Checking here first, before
// any entry is defined, means every collision — against a built-in name or
// against an earlier entry in this same list — raises the same
// `ParameterTypeCollisionError` (decision 2), regardless of which happens to
// come first in a given `parameterTypes` array. Every caller of this factory
// is expected to treat that error as config-originated (decision 3): `nuka
// check` catches it and reports a `parameter-type-invalid` issue (src/check/
// binding-check.ts); `nuka do`/`nuka run` let it propagate as a setup
// failure. An unregistered type name used in a pattern is a different
// problem — cucumber-expressions' own `UndefinedParameterTypeError`, thrown
// when the pattern's expression is built, not here.
export function createParameterTypeRegistry(
  customTypes: readonly ParameterTypeConfig[] = [],
): ParameterTypeRegistry {
  const registry = new ParameterTypeRegistry();

  const builtinNames = new Set<string>();
  for (const parameterType of registry.parameterTypes) {
    if (parameterType.name !== undefined) {
      builtinNames.add(parameterType.name);
    }
  }

  const configuredNames = new Set<string>();
  for (const entry of customTypes) {
    if (builtinNames.has(entry.name)) {
      throw new ParameterTypeCollisionError(entry.name, "built-in");
    }
    if (configuredNames.has(entry.name)) {
      throw new ParameterTypeCollisionError(entry.name, "duplicate");
    }
    configuredNames.add(entry.name);

    // `type: null` — the constructor's third argument is only ever consulted
    // for snippet generation (cucumber-expressions' own
    // CucumberExpressionGenerator), which this project doesn't use; matching
    // and transformation both go through `regexps`/`transform` alone.
    registry.defineParameterType(
      new ParameterType(entry.name, entry.regexp, null, entry.transformer),
    );
  }

  return registry;
}
