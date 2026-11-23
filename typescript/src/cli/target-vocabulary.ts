import type { CompatParameterTypeEntry, Vocabulary } from "../discover/discover-steps.js";
import type { ParameterTypeConfig } from "../config/schema.js";
import { checkBindings } from "../check/binding-check.js";
import { createStepTextMatcher } from "../check/feature-check.js";
import { attachStepLines } from "../feature/load-features.js";
import type { Finding } from "../finding/finding.js";
import { selectPickles } from "../run/select-pickles.js";
import { shellWord } from "../shell/shell-word.js";
import type { StepSummary } from "./vocabulary.js";

// Responsibility: `nuka steps <target>...`, the vocabulary of the scenarios
// a target selects. An agent that edits one scenario reads the steps its
// lines bind and the steps those call through `parts`, not the whole
// project's vocabulary. Each listed step names the lines that bind it.
//
// A line that binds no single step is a finding, not a silent gap: a list
// that leaves out the step a line was meant to bind reads as complete.
// Whether the line or a pattern is wrong is `nuka check`'s report to give,
// so this module only names the line.

export interface TargetVocabulary {
  readonly summaries: readonly StepSummary[];
  readonly findings: readonly Finding[];
}

/** Selects targets the way `nuka run` does (a file, a `file:line`, or a
 * directory) and throws its refusals. Feature line matching is the one
 * `nuka check` and `nuka run` use: a line binds a step only when exactly
 * one step matches it. */
export function vocabularyOfTargets(
  rootDir: string,
  targets: readonly string[],
  vocabulary: Vocabulary,
  summaries: readonly StepSummary[],
  parameterTypes: readonly ParameterTypeConfig[],
  compatParameterTypes: readonly CompatParameterTypeEntry[],
): TargetVocabulary {
  const selection = selectPickles(rootDir, targets);
  const match = createStepTextMatcher(checkBindings(vocabulary, parameterTypes, compatParameterTypes).patterns);
  const linesByStep = new Map<string, string[]>();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const feature of selection.features) {
    for (const pickle of attachStepLines(feature.pickles, feature.gherkinDocument)) {
      for (const step of pickle.steps) {
        const where = `${feature.relativePath}:${step.line ?? 0}`;
        // A Background line and an outline step repeat in each pickle;
        // the line is one place to edit, so it is named once.
        if (seen.has(where)) continue;
        seen.add(where);
        const { stepNames } = match(step.text);
        const at = { severity: "error" as const, file: feature.relativePath, ...(step.line === undefined ? {} : { line: step.line }) };
        if (stepNames.length === 1) {
          const lines = linesByStep.get(stepNames[0]!) ?? [];
          lines.push(where);
          linesByStep.set(stepNames[0]!, lines);
        } else if (stepNames.length === 0) {
          findings.push({
            ...at,
            code: "undefined-step",
            message: `No step definition matches "${step.text}"`,
            do: `nuka scaffold --feature ${shellWord(feature.relativePath)}`,
          });
        } else {
          findings.push({
            ...at,
            code: "ambiguous-step",
            message: `"${step.text}" matches more than one step: ${[...stepNames].sort().join(", ")}`,
          });
        }
      }
    }
  }

  const byName = new Map(summaries.map((summary) => [summary.name, summary]));
  const partOf = new Map<string, string[]>();
  const listed = new Set(linesByStep.keys());
  const pending = [...listed];
  while (pending.length > 0) {
    const name = pending.shift()!;
    for (const part of byName.get(name)?.parts ?? []) {
      const callers = partOf.get(part) ?? [];
      if (!callers.includes(name)) callers.push(name);
      partOf.set(part, callers);
      if (!listed.has(part)) {
        listed.add(part);
        pending.push(part);
      }
    }
  }

  return {
    summaries: summaries
      .filter((summary) => listed.has(summary.name))
      .map((summary) => {
        const callers = partOf.get(summary.name);
        return { ...summary, lines: linesByStep.get(summary.name) ?? [], ...(callers === undefined ? {} : { part_of: callers }) };
      }),
    findings,
  };
}
