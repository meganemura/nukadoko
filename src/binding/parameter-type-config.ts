// Responsibility: the shape of one `parameterTypes` entry, owned here
// because the registry is what consumes it. The config schema validates
// the same shape and imports this type so the two cannot drift, and so
// binding does not import the config module to name its own input.

export interface ParameterTypeConfig {
  readonly name: string;
  readonly regexp: RegExp | string;
  readonly transformer?: (...match: string[]) => unknown;
}
