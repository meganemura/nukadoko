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
  /** The names the config defines, which a CLI refusal's `do:` line offers
   * in place of the unknown one (src/cli/refusal.ts reads `do` off any
   * error). */
  readonly do: string;

  constructor(environmentName: string, definedNames: readonly string[]) {
    super(
      `Unknown environment "${environmentName}": not defined in nukadoko.config.ts's "environments"`,
    );
    this.name = "UnknownEnvironmentError";
    this.environmentName = environmentName;
    const add = `add environments.${environmentName} to the config file`;
    this.do =
      definedNames.length === 0
        ? `Leave out --env (the config defines no environments), or ${add}.`
        : `Pass --env with a name the config defines (${[...definedNames].sort().join(", ")}), or ${add}.`;
  }
}

/** The refusal for a mutating step that targets an environment whose `policy`
 * is `"read-only"`. Never thrown: `nuka do` and `nuka run` each report the
 * refusal as a plain message, and this class is the one home of that
 * message so the two cannot word it differently. */
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
