// Responsibility: the one error type raised while registering
// `config.parameterTypes` (src/binding/registry.ts) — a custom entry's name
// collides with either one of cucumber-expressions' own built-in types (int,
// float, word, string, the anonymous type, ...) or another custom entry
// earlier in the same config's `parameterTypes` list. Kept separate from
// registry.ts so callers (src/check/binding-check.ts, src/check/feature-
// check.ts, src/run/match-step.ts) can `instanceof` it without pulling in the
// registry-building code itself — same convention as config/errors.ts,
// binding/errors.ts. This is a config-authoring error, not a pattern-syntax
// one: callers that build a
// registry from config are expected to treat it that way — `nuka check`
// reports it as a `parameter-type-invalid` issue, `nuka do`/`nuka run` treat
// it as a setup failure (stderr + exit 1, no receipt).

export type ParameterTypeCollisionReason = "built-in" | "duplicate";

export class ParameterTypeCollisionError extends Error {
  readonly typeName: string;
  readonly reason: ParameterTypeCollisionReason;

  constructor(typeName: string, reason: ParameterTypeCollisionReason) {
    const detail =
      reason === "built-in"
        ? `collides with one of cucumber-expressions' own built-in parameter types; redefining what {${typeName}} means would quietly change the meaning of every pattern that already uses it`
        : "is registered more than once in parameterTypes";
    super(`Custom parameter type "${typeName}" ${detail}`);
    this.name = "ParameterTypeCollisionError";
    this.typeName = typeName;
    this.reason = reason;
  }
}
