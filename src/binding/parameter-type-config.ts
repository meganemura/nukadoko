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

/** What the registry accepts. Only a compat `defineParameterType` call sets
 * `preferForRegexpMatch`; the config entry stays the shape above. */
export interface RegisteredParameterType extends ParameterTypeConfig {
  /** Picks this type for a RegExp group that several types match, as in
   * cucumber-js. A cucumber expression names its type, so it never reads
   * this. */
  readonly preferForRegexpMatch?: boolean;
}
