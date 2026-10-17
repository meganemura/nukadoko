// Responsibility: the values and sentences a command's option table uses
// (in --help or in its own argv check) and its handler also enforces. They
// live apart from the handlers because run-cli.ts builds every option table
// eagerly but loads a handler's module only when that command runs, so
// `nuka --help` must reach these without loading the explore engine.

export const DEFAULT_EXPLORE_RUNS = 20;
export const DEFAULT_EXPLORE_LENGTH = 10;

/** A step name, which `nuka scaffold` also uses as the file name. */
export const VALID_STEP_NAME = /^[a-z0-9-]+$/;

/** Why a step name ended up as `--command`'s value. The parser's check says
 * it when no name is left for the positional; scaffold says it when the
 * value is not a file. */
export function commandTookTheName(value: string): string {
  return `--command before the name takes the next word as its value (${JSON.stringify(value)} here); write the name first, or give --command a value`;
}
