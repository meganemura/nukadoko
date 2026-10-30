import type { Pickle } from "@cucumber/messages";
import type { LoadedProgram } from "../config/load-program.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { worldsToStart } from "../environment/resolve-environment.js";
import { namesPlaceholder } from "../program/placeholders.js";
import {
  producersOf,
  isClaimStep,
  type Step,
} from "../step/define-step.js";
import type { BoundStepLine, StepTextMatcher } from "./feature-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `nuka check` findings for a claim step's `events`
// (docs/spec.md "A claim on a count of events") that can only end one
// way. A count of an earlier step's execution events is read at run time,
// and the run leaves every claim on it unjudged when nothing can be read:
// no earlier line ran a step `of` names (`producer-not-run`), two of its
// candidates ran so none can be chosen, the world's program file names no
// `{events}` (`inlet-unnamed`), or nukadoko does not serve the world
// (`world-unread`). Each of those is known from the feature file, the
// step contracts, and the program file, so the check names it before a
// world starts. What only the lines can say (a kind the program never
// reports, a job that never performs) stays the run's.
//
// The order rule is `from`'s (src/check/from-order.ts): a line binds a
// step only when exactly one step matches it, a candidate counts once
// however many earlier lines run it, and the latest of those is the one
// counted. A missing producer behind a line no step matches is held back
// in silence: that line is often the producer, mistyped, and its own
// `undefined-step` error already fails the check. Two candidates that ran
// stay an error, since no later wording of an undefined line lowers how
// many already did.
//
// The world findings are judged for the worlds a `nuka run` with the same
// `--env` flags would start, once per world, naming each bound step that
// declares `events`: the fix is the program file's, so one line per
// world says it once. A served world whose program file names no
// `{events}` is an error, since the fix is in the project's own file. A
// world nukadoko does not serve (a url, or no program file) is a warning:
// such a world is often one the project does not run, such as a shared
// staging server, the other scenarios still have something to say there,
// and the run names each claim it cannot judge with `world-unread`.

/** One events key whose producer the scenario cannot supply. */
export interface EventsOrderIssue {
  /** 0-based index into `pickle.steps`: the claim step's line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly code: "events-producer-missing" | "events-producer-ambiguous";
  readonly message: string;
  readonly fix: string;
}

/** `"a"`, `"a" and "b"`, `"a", "b", and "c"`: the run's own way of
 * naming candidates (src/run/run-scenario.ts). */
function quoted(names: readonly string[]): string {
  const each = names.map((name) => `"${name}"`);
  if (each.length <= 2) return each.join(" and ");
  return `${each.slice(0, -1).join(", ")}, and ${each.at(-1)}`;
}

/** The events keys of each claim step bound in `pickle` whose `of`
 * names no step an earlier line runs, or two that earlier lines run.
 * Pure. */
export function checkEventsOrder(
  pickle: Pickle,
  vocabulary: Vocabulary,
  match: StepTextMatcher,
): readonly EventsOrderIssue[] {
  const matches = pickle.steps.map((step) => match(step.text));
  const resolved = matches.map((result) =>
    result.stepNames.length === 1 ? result.stepNames[0] : undefined,
  );
  const nameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") nameOf.set(entry.step, entry.name);
  }
  const issues: EventsOrderIssue[] = [];
  pickle.steps.forEach((_, stepIndex) => {
    const stepName = resolved[stepIndex];
    const entry = stepName === undefined ? undefined : vocabulary.get(stepName);
    if (
      stepName === undefined ||
      entry === undefined ||
      entry.kind !== "typed" ||
      !isClaimStep(entry.step)
    )
      return;
    const before = resolved.slice(0, stepIndex);
    const undefinedBefore = matches
      .slice(0, stepIndex)
      .some((earlier) => earlier.stepNames.length === 0);
    for (const [key, events] of Object.entries(entry.step.events)) {
      const names = producersOf(events).flatMap((step) => {
        const name = nameOf.get(step);
        return name === undefined ? [] : [name];
      });
      // A candidate no step file registers is in no line's binding; the
      // run counts nothing for it either way, and its import is the fix.
      if (names.length === 0) continue;
      const ran = names.filter((name) => before.includes(name));
      if (ran.length === 1) continue;
      const where = `Step "${stepName}"'s events.${key}`;
      if (ran.length >= 2) {
        issues.push({
          stepIndex,
          stepName,
          code: "events-producer-ambiguous",
          message:
            `${where} counts the execution events of one of steps ${quoted(names)}, and ${quoted(ran)} each ran earlier in this scenario, ` +
            "so the run cannot choose whose events to count, and each claim on the count is unjudged",
          fix: `Remove or move lines so that exactly one of steps ${quoted(ran)} runs before this line.`,
        });
        continue;
      }
      if (undefinedBefore) continue;
      const status = names
        .map((name) =>
          resolved.includes(name)
            ? `"${name}" runs only at or after this line`
            : `"${name}" runs nowhere in this scenario`,
        )
        .join("; ");
      const whose =
        names.length === 1
          ? `step "${names[0]}"`
          : `exactly one of steps ${quoted(names)}`;
      issues.push({
        stepIndex,
        stepName,
        code: "events-producer-missing",
        message: `${where} counts the execution events of ${whose}, and no earlier line runs it: ${status}. Each claim on the count is unjudged (producer-not-run)`,
        fix:
          `Put a line that runs ${whose} earlier in the scenario, or, if an earlier line runs the step whose execution events the claim means, ` +
          `list that step in events.${key}.of of step "${stepName}".`,
      });
    }
  });
  return issues;
}

/** The bound steps that declare `events`, by name, once each. */
function eventsStepsOf(
  bound: readonly BoundStepLine[],
  vocabulary: Vocabulary,
): readonly string[] {
  const names = new Set<string>();
  for (const line of bound) {
    const entry = vocabulary.get(line.stepName);
    if (
      entry?.kind === "typed" &&
      isClaimStep(entry.step) &&
      Object.keys(entry.step.events).length > 0
    )
      names.add(line.stepName);
  }
  return [...names];
}

/** `events-inlet-missing` (errors) and `events-unread` (warnings) for
 * the worlds a run with `envs` starts, when a bound step declares
 * `events`: a world nukadoko serves whose program file names no
 * `{events}`, and a world it does not serve, or a project with no program
 * file to start one. Pure. */
export function findEventsWorldGaps(
  bound: readonly BoundStepLine[],
  vocabulary: Vocabulary,
  program: LoadedProgram | null,
  envs: readonly string[],
  programFileName: string,
): { readonly errors: CheckIssue[]; readonly warnings: CheckIssue[] } {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const steps = eventsStepsOf(bound, vocabulary);
  if (steps.length === 0) return { errors, warnings };
  const counting = `${steps.length === 1 ? "step" : "steps"} ${quoted(steps)} ${steps.length === 1 ? "counts" : "count"} execution events`;
  if (program === null) {
    warnings.push({
      code: "events-unread",
      message: `${counting}, and the project has no ${programFileName}, so no world starts and nukadoko reads no execution events: each claim on a count is unjudged (world-unread)`,
      fix: `Write ${programFileName} with serve, the command that starts the program, and {events} in env, such as env: { EXECUTION_EVENTS: "{events}" }.`,
    });
    return { errors, warnings };
  }
  for (const world of worldsToStart(program.program, envs)) {
    const { reach } = world.recipe;
    if (reach.kind === "serve") {
      if (namesPlaceholder(world.recipe, "events")) continue;
      errors.push({
        code: "events-inlet-missing",
        message: `world ${world.name}: ${counting}, and the program file names no {events}, so the program has no file to write them to: each claim on a count is unjudged (inlet-unnamed)`,
        file: program.fileName,
        fix: `Name {events} in env of ${program.fileName} for world ${world.name}, such as env: { EXECUTION_EVENTS: "{events}" }, and have the program append its execution events to that file (docs/execution-events.md).`,
      });
      continue;
    }
    const why =
      reach.kind === "url"
        ? "the program runs at a url, which nukadoko does not start"
        : "it has neither serve nor url, so no program runs";
    warnings.push({
      code: "events-unread",
      message: `world ${world.name}: ${counting}, and ${why}, so nukadoko reads no execution events there: each claim on a count is unjudged (world-unread)`,
      file: program.fileName,
      fix: `Run these scenarios in a world nukadoko serves: give world ${world.name} serve in ${program.fileName}, with {events} in env, or select one that has it with --env.`,
    });
  }
  return { errors, warnings };
}
