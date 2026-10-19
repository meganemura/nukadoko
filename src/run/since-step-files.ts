import path from "node:path";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";

// Responsibility: which files `nuka run --since` compares with the ref for
// one step name, and for the whole vocabulary: the file that registers the
// step, the files of the parts it declares, however deep, and the config
// file when the step needs a fixture the config defines. Not what those
// files import: following imports would mean resolving modules the way the
// loader does, and a guess at that list would name files the step never
// reads. Boundary: the comparison itself is src/run/criteria-since.ts,
// and src/cli/run.ts passes it what this returns.

export interface SinceStepFilesInput {
  readonly rootDir: string;
  readonly vocabulary: Vocabulary;
  /** The config file's name relative to the project root. */
  readonly configFile: string;
  /** The fixture names the config defines. */
  readonly definedFixtures: ReadonlySet<string>;
}

export interface SinceStepFiles {
  /** Every file any step of the vocabulary names, sorted. */
  readonly all: readonly string[];
  /** The files one step name names, or none for a name the vocabulary
   * does not hold. */
  readonly ofEntry: (entryName: string) => readonly string[];
}

export function sinceStepFiles(input: SinceStepFilesInput): SinceStepFiles {
  const { rootDir, vocabulary, configFile, definedFixtures } = input;
  const projectRelative = (filePath: string): string => path.relative(rootDir, path.resolve(rootDir, filePath));
  const fileOfStep = new Map<Step, string>();
  for (const entry of vocabulary.values()) if (entry.kind === "typed") fileOfStep.set(entry.step, projectRelative(entry.filePath));
  const ofEntry = (entryName: string): string[] => {
    const entry = vocabulary.get(entryName);
    if (entry === undefined) return [];
    const files = new Set([projectRelative(entry.filePath)]);
    if (entry.kind === "typed") {
      const seen = new Set<Step>();
      const visit = (step: Step): void => {
        if (seen.has(step)) return;
        seen.add(step);
        const file = fileOfStep.get(step);
        if (file !== undefined) files.add(file);
        for (const part of step.parts) visit(part);
      };
      visit(entry.step);
      let needs: readonly string[] = [];
      try {
        needs = stepFixtureNames(entry.step);
      } catch {
        // A run() whose fixtures cannot be read names none here; the
        // fixture check reports it.
      }
      if (needs.some((name) => definedFixtures.has(name))) files.add(configFile);
    }
    return [...files];
  };
  const all = [...new Set([...vocabulary.keys()].flatMap(ofEntry))].sort((a, b) => a.localeCompare(b));
  return { all, ofEntry };
}
