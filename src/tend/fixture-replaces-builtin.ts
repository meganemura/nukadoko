import type { ReplaceableFixtures } from "../step/context.js";
import type { TendIssue } from "./types.js";

// Responsibility: the note for a `config.fixtures` entry named after a
// replaceable builtin. Projects wrote their own `scratch` fixture, with a
// `StepFixtures` declaration, before nukadoko built one in, and an upgrade
// leaves that copy working: `nuka check` and the run both accept it, so
// nothing else tells the project the builtin exists. The note states only
// what the config shows, that the entry replaces the builtin. Whether the
// builtin's shape covers the project's own is for the reader to decide.
//
// Keyed by `ReplaceableFixtures`, so a builtin added there without a line
// here fails to compile.

const BUILTIN_SHAPE: Record<keyof ReplaceableFixtures, string> = {
  scratch:
    "scratch.dir(prefix) and scratch.copy(source), each a new temporary directory that is removed when the scenario ends and listed in the step record's evidence.scratch",
};

export function findFixturesReplacingBuiltins(fixtureNames: Iterable<string>): TendIssue[] {
  const issues: TendIssue[] = [];
  for (const name of fixtureNames) {
    if (!Object.hasOwn(BUILTIN_SHAPE, name)) continue;
    const shape = BUILTIN_SHAPE[name as keyof ReplaceableFixtures];
    issues.push({
      code: "fixture-replaces-builtin",
      message: `Fixture "${name}" in config.fixtures replaces nukadoko's builtin ${name} fixture, which gives ${shape}.`,
      fixture: name,
      do: `Delete the ${name} fixture from config.fixtures, and its StepFixtures declaration, if the builtin covers what it does; keep both if the project needs its own shape.`,
    });
  }
  return issues;
}
