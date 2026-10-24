// Responsibility: the error types environment resolution and its runtime
// `--env` validation raise, kept separate from the modules that throw them
// (resolve-environment.ts) so callers (cli/do.ts, tests) can `instanceof`
// them without pulling in that module's other dependencies, the same
// convention as config/errors.ts.

/** Thrown only when `--env <name>` was given explicitly and `name` has no
 * matching entry in nukadoko.program.ts's `environments`. The "default"
 * environment, implicit or named by `--env default`, never throws this even
 * when `environments.default` is undefined — see resolve-environment.ts. */
export class UnknownEnvironmentError extends Error {
  readonly code = "unknown-environment";
  readonly environmentName: string;
  /** The names `--env` accepts, which a CLI refusal's `fix:` line offers
   * in place of the unknown one: `default` (always accepted, see
   * resolve-environment.ts) and every name the program file defines. */
  readonly fix: string;

  constructor(environmentName: string, definedNames: readonly string[]) {
    super(
      `Unknown environment "${environmentName}": not defined in nukadoko.program.ts's "environments"`,
    );
    this.name = "UnknownEnvironmentError";
    this.environmentName = environmentName;
    const add = `add environments.${environmentName} to nukadoko.program.ts`;
    const valid = [...new Set(["default", ...definedNames])].sort();
    this.fix =
      definedNames.length === 0
        ? `Leave out --env or pass --env default (nukadoko.program.ts defines no other environment), or ${add}.`
        : `Pass --env with a name it accepts (${valid.join(", ")}), or ${add}.`;
  }
}

/** The refusal for a mutating step that targets an environment whose `policy`
 * is `"read-only"`. Never thrown: `nuka do` and `nuka run` each report the
 * refusal as a plain message, and this class is the one home of that
 * message so the two cannot word it differently. */
export class ReadOnlyEnvironmentError extends Error {
  readonly code = "read-only-environment";
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
