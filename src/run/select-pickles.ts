import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pickle } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import { FeatureFileNotFoundError, FeatureParseFailedError, NoMatchingScenarioError } from "./errors.js";

// Responsibility: turn `nuka run`'s `<feature[:line]>` argument into the
// pickle(s) it selects (this task's spec, decision 1) — the one place that
// argument's syntax and gherkin's own pickle `location` are both known. A
// missing file, a parse failure, or (when `:line` was given) zero matching
// pickles are all setup failures, thrown here before anything about the run
// is decided (this task's spec, decision 2); cli/run.ts turns them into
// stderr + exit 1 the same way it already does for config/environment
// errors.

export interface FeatureTarget {
  readonly relativePath: string;
  /** `null` when no `:line` was given — every pickle in the file runs, in
   * file order. */
  readonly line: number | null;
}

// Matches a trailing `:<digits>` and nothing else, so a feature path itself
// is never mistaken for carrying a line number (there is no legitimate
// `.feature` path ending in `:123` on its own).
const LINE_SUFFIX_PATTERN = /^(.+):(\d+)$/;

export function parseFeatureTarget(featureArg: string): FeatureTarget {
  const match = LINE_SUFFIX_PATTERN.exec(featureArg);
  if (!match) {
    return { relativePath: featureArg, line: null };
  }
  return { relativePath: match[1]!, line: Number(match[2]!) };
}

export interface SelectedScenarios {
  readonly relativePath: string;
  readonly pickles: readonly Pickle[];
}

/**
 * Loads exactly one `.feature` file and selects which of its pickles `nuka
 * run` executes: every pickle in file order when no `:line` was given, or
 * only the pickle(s) whose own gherkin `location.line` equals it when one
 * was — a Scenario Outline's Examples row included, since `@cucumber/
 * gherkin`'s `compile()` assigns each expanded pickle the location of the
 * row that produced it, not the outline's own line (verified against this
 * repo's own check-clean-project fixture).
 */
export function selectPickles(rootDir: string, featureArg: string): SelectedScenarios {
  const target = parseFeatureTarget(featureArg);
  const absolutePath = path.join(rootDir, target.relativePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    throw new FeatureFileNotFoundError(target.relativePath);
  }

  let allPickles: readonly Pickle[];
  try {
    allPickles = parseFeatureSource(source, target.relativePath);
  } catch (error) {
    throw new FeatureParseFailedError(target.relativePath, error);
  }

  if (target.line === null) {
    return { relativePath: target.relativePath, pickles: allPickles };
  }

  const matching = allPickles.filter((pickle) => pickle.location?.line === target.line);
  if (matching.length === 0) {
    throw new NoMatchingScenarioError(target.relativePath, target.line);
  }
  return { relativePath: target.relativePath, pickles: matching };
}
