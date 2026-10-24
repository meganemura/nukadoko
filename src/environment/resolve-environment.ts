import type { Conditions } from "../condition/condition.js";
import type { NukadokoConfig } from "../config/schema.js";
import { layerProgram, type Program, type ProgramRecipe } from "../config/program-schema.js";
import { UnknownEnvironmentError } from "./errors.js";
export { ReadOnlyEnvironmentError } from "./errors.js";

// Responsibility: turn a `--env` name, the loaded config, and the loaded
// program file into the *effective* settings one environment's pass uses,
// and never anything else's job (cli/run.ts and cli/do.ts wire the result
// into the read-only check, the version probe, env files, and the world
// they start; neither re-derives any of this layering itself).
//
// Environments live in nukadoko.program.ts, beside the program they
// change, and not in the config, which holds the criteria. Layering rule:
// the program's fields are the environment's over the top level's
// (`layerProgram`, src/config/program-schema.ts); effective envFiles =
// [...config.envFiles, ...environment.envFiles] (append, later files
// winning when merged by context/env.ts, the same "common +
// per-environment override" shape as dotenv's own convention).
// `policy`/`version` exist only per-environment; there is no top-level
// fallback for either.
//
// Unknown-name handling depends on whether `--env` was given
// explicitly: an explicit name with no matching `environments` entry is a
// setup failure (`UnknownEnvironmentError`), but the implicit environment
// (no `--env` at all) is *not* required to have a matching entry: it just
// resolves with no per-environment overrides. The implicit environment is
// named "default" everywhere a run records one (run.json's cells, the
// summary's columns, a scenario's `environment`), so `--env default` names
// it too, and `nuka run --env default --env staging` runs both. The
// alternative refused was refusing `--env default` unless the program file
// defines it, which left the environment every record names as the one
// name `--env` could not combine with others. A program file that does
// define `environments.default` keeps its entry.

export const DEFAULT_ENVIRONMENT_NAME = "default";

/** The environments a run with no `--env` runs, in the order the program
 * file names them: every environment that declares `conditions`, when at
 * least one does, and `default` otherwise. The scenarios name the
 * conditions they need, so the run that covers them is the one over every
 * environment that sets one up. An environment with no `conditions` is a
 * deployment target (a staging server, a preview), which needs a URL or
 * credentials a local run may not have, so it runs only when `--env`
 * names it. `conditions: {}` puts an environment in this set with no
 * condition on, as the side where every flag is off. Pure. */
export function defaultEnvironmentNames(program: Program | null): string[] {
  const conditioned = Object.entries(program?.environments ?? {})
    .filter(([, environment]) => environment.conditions !== undefined)
    .map(([name]) => name);
  return conditioned.length > 0 ? conditioned : [DEFAULT_ENVIRONMENT_NAME];
}

/** The worlds a `nuka run` with these `--env` names starts, each with its
 * recipe, once per name: the `defaultEnvironmentNames` when `envs` is
 * empty, as `nuka run` selects them. A name the program file does not
 * define, other than `default`, is left out: `resolveEnvironment`
 * refuses it by name for the command that named it.
 * `nuka check` checks these worlds and no others, so a world no command
 * of this invocation starts never refuses a program for a placeholder. */
export function worldsToStart(program: Program, envs: readonly string[]): { readonly name: string; readonly recipe: ProgramRecipe }[] {
  const environments = program.environments ?? {};
  const names = envs.length === 0 ? defaultEnvironmentNames(program) : [...new Set(envs)];
  return names.flatMap((name) => {
    const environment = Object.hasOwn(environments, name) ? environments[name] : undefined;
    if (environment === undefined && name !== DEFAULT_ENVIRONMENT_NAME) return [];
    return [{ name, recipe: layerProgram(program, environment) }];
  });
}

export interface ResolvedEnvironment {
  readonly name: string;
  readonly envFiles: readonly string[];
  readonly policy: "read-only" | undefined;
  readonly version: (() => string | Promise<string>) | undefined;
  /** What the environment declares it sets up; `undefined` when it
   * declares nothing, which src/condition/condition.ts reads as every
   * condition off. */
  readonly conditions: Conditions | undefined;
  /** The program this environment's world builds and reaches, or `null`
   * when the tree has no program file and the run starts no world. */
  readonly program: ProgramRecipe | null;
}

export function resolveEnvironment(
  config: NukadokoConfig,
  program: Program | null,
  name: string,
  explicit: boolean,
): ResolvedEnvironment {
  // Bracket access walks Object.prototype, so "constructor" and "toString"
  // read as present on every plain `environments` object even when the
  // program file never defined them. Only an own entry is a name that exists.
  const environments = program?.environments;
  const environment =
    environments !== undefined && Object.hasOwn(environments, name) ? environments[name] : undefined;
  if (environment === undefined && explicit && name !== DEFAULT_ENVIRONMENT_NAME) {
    throw new UnknownEnvironmentError(name, Object.keys(environments ?? {}));
  }

  return {
    name,
    envFiles: [...(config.envFiles ?? []), ...(environment?.envFiles ?? [])],
    policy: environment?.policy,
    version: environment?.version,
    conditions: environment?.conditions,
    program: program === null ? null : layerProgram(program, environment),
  };
}
