// Responsibility: the error types environment resolution and its runtime
// `--env` validation raise, kept separate from the modules that throw them
// (name.ts, resolve-environment.ts) so callers (cli/do.ts, cli/session.ts,
// tests) can `instanceof` them without pulling in those modules' other
// dependencies — same convention as session/errors.ts and config/errors.ts.

export class InvalidEnvironmentNameError extends Error {
  readonly environmentName: string;

  constructor(environmentName: string) {
    super(`Invalid environment name "${environmentName}": must match [a-z0-9_-]+`);
    this.name = "InvalidEnvironmentNameError";
    this.environmentName = environmentName;
  }
}

/** Thrown only when `--env <name>` was given explicitly and `name` has no
 * matching entry in nukadoko.config.ts's `environments`. The implicit
 * "default" environment never throws this even
 * when `environments.default` is undefined — see resolve-environment.ts. */
export class UnknownEnvironmentError extends Error {
  readonly environmentName: string;

  constructor(environmentName: string) {
    super(
      `Unknown environment "${environmentName}": not defined in nukadoko.config.ts's "environments"`,
    );
    this.name = "UnknownEnvironmentError";
    this.environmentName = environmentName;
  }
}

/** Thrown in `nuka do`'s setup phase (before any step record is written) when a
 * mutating step targets an environment whose `policy` is `"read-only"`. */
export class ReadOnlyEnvironmentError extends Error {
  readonly stepName: string;
  readonly environmentName: string;

  constructor(stepName: string, environmentName: string) {
    super(
      `Step "${stepName}" mutates state but environment "${environmentName}" has policy "read-only"`,
    );
    this.name = "ReadOnlyEnvironmentError";
    this.stepName = stepName;
    this.environmentName = environmentName;
  }
}
