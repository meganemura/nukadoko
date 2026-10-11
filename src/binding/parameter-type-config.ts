// Responsibility: the shape of one `parameterTypes` entry, owned here
// because the registry is what consumes it. The config schema validates
// the same shape and imports this type so the two cannot drift, and so
// binding does not import the config module to name its own input.

export interface ParameterTypeConfig {
  readonly name: string;
  readonly regexp: RegExp | string;
  /** Coercion only. At run time its `this` is the scenario World, and a
   * returned Promise is awaited before the step (src/run/match-step.ts).
   * The args schema remains the contract. */
  readonly transformer?: (...match: string[]) => unknown;
}
