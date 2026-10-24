// Responsibility: the environment a `runCommand` process got, written as
// its difference from the runner's own (docs/spec.md "Records",
// `observed.processes[].env`). Pure; the caller decides which values the
// record may show.
//
// A difference, not the whole environment: the runner's environment holds
// tens of variables that say nothing about the step, some of them
// credentials, and a reader wants the ones the step chose. A variable the
// step removed is named without its value, since the value was never
// given to the program.

/** The raw difference, values as the process got them. Never written to a
 * record as it is: `recordedEnv` in run-command.ts hides each value that
 * could be a credential. */
export type EnvDifference =
  | { readonly inherited: true }
  | {
      readonly added: Readonly<Record<string, string>>;
      readonly changed: Readonly<Record<string, string>>;
      readonly removed: readonly string[];
    };

/** `given` against `runner`. `{ inherited: true }` when the step passed no
 * environment, or passed the runner's own object. A variable set to
 * `undefined` counts as absent, as it does for Node's `spawn`. Names are
 * sorted, so the same inputs always give the same record. */
export function envDifference(
  runner: NodeJS.ProcessEnv,
  given: NodeJS.ProcessEnv | undefined,
): EnvDifference {
  if (given === undefined || given === runner) return { inherited: true };
  const added: Record<string, string> = {};
  const changed: Record<string, string> = {};
  for (const name of Object.keys(given).sort()) {
    const value = given[name];
    if (value === undefined) continue;
    const own = runner[name];
    if (own === undefined) added[name] = value;
    else if (own !== value) changed[name] = value;
  }
  const removed = Object.keys(runner)
    .filter((name) => runner[name] !== undefined && given[name] === undefined)
    .sort();
  return { added, changed, removed };
}
