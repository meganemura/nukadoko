import { conditionTagText, describeConditions, readCriterionTags, roleIn, type Conditions } from "../condition/condition.js";
import type { Program } from "../config/program-schema.js";
import type { ConditionTagOccurrence, FeatureFile } from "../feature/load-features.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the three findings about condition tags (docs/spec.md
// "Verdicts"). `condition-tag-malformed` and `condition-unknown` are facts
// of one tag where the file writes it; `condition-unmet` is a fact of one
// scenario, from every tag it carries, against the environments the run
// selects. Boundary: pure; reading the files and the program is
// src/check/analyze.ts's.
//
// `condition-unmet` reads the run's selection, not every environment: a
// scenario that only a deployment target meets has no required cell in a
// run that leaves the target out, and a run with no required cell for a
// criterion holds no evidence for it.

/** One environment a run selects, with what it declares. */
export interface SelectedConditions {
  readonly name: string;
  readonly conditions: Conditions | undefined;
}

export interface ConditionCheckInput {
  readonly conditionTags: readonly ConditionTagOccurrence[];
  readonly features: readonly FeatureFile[];
  readonly program: Program | null;
  readonly programFile: string;
  readonly selected: readonly SelectedConditions[];
}

export function checkConditions(input: ConditionCheckInput): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const declared = new Set(Object.values(input.program?.environments ?? {}).flatMap((environment) => Object.keys(environment.conditions ?? {})));
  for (const occurrence of input.conditionTags) {
    const where = { file: occurrence.relativePath, line: occurrence.line };
    if (occurrence.read === undefined) {
      issues.push({
        code: "condition-tag-malformed",
        message: `${occurrence.tag} does not read as @with:<condition>, @with:<condition>=<value>, or @without:<condition>, so it names no condition`,
        ...where,
      });
      continue;
    }
    if (declared.has(occurrence.read.name)) continue;
    const name = occurrence.read.name;
    const on = occurrence.read.kind === "without" ? "off" : "on";
    const off = occurrence.read.kind === "without" ? "on" : "off";
    issues.push({
      code: "condition-unknown",
      message:
        `${occurrence.tag} names the condition "${name}", and no environment in ${input.programFile} declares it under conditions. ` +
        `If ${name} was removed and its ${on} side kept, remove the tag, so the scenario holds everywhere; if its ${off} side was kept, delete the scenario.`,
      ...where,
    });
  }
  const unknownNames = new Set(input.conditionTags.flatMap((occurrence) => (occurrence.read !== undefined && !declared.has(occurrence.read.name) ? [occurrence.read.name] : [])));
  const environments = input.selected.map((environment) => `${environment.name} (${describeConditions(environment.conditions)})`).join("; ");
  for (const feature of input.features) {
    for (const pickle of feature.pickles) {
      const { conditions, malformed } = readCriterionTags(pickle.tags.map((tag) => tag.name));
      // A tag that does not read, or names a condition nothing declares,
      // already has its finding; this one would repeat it.
      if (conditions.length === 0 || malformed.length > 0 || conditions.some((tag) => unknownNames.has(tag.name))) continue;
      if (input.selected.some((environment) => roleIn(conditions, environment.conditions) === "required")) continue;
      issues.push({
        code: "condition-unmet",
        message:
          `Scenario "${pickle.name}" needs ${conditions.map(conditionTagText).join(" ")}, and no selected environment meets ${conditions.length === 1 ? "it" : "all of them"}: ${environments}. ` +
          "Its cells would all be controls, so nothing would show that it holds",
        file: feature.relativePath,
        ...(pickle.location === undefined ? {} : { line: pickle.location.line }),
      });
    }
  }
  return issues;
}
