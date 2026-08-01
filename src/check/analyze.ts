import { loadConfig } from "../config/load-config.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { loadFeatures } from "../feature/load-features.js";
import { checkBindings } from "./binding-check.js";
import { checkConfig } from "./config-check.js";
import { checkFeatures } from "./feature-check.js";
import type { CheckIssue, CheckReport } from "./types.js";

// Responsibility: the one function `nuka check` runs — load the project the
// same way `nuka steps`/`nuka do` already do (loadConfig, discoverSteps),
// then run every check category and merge their issues into the single
// `{ errors, warnings }` report docs/spec.md's "CLI summary" describes. A
// project's config failing to load, or discovery throwing (duplicate step
// name, a broken step file), is *not* one of this report's issues — it is
// the same fundamental failure `nuka steps`/`nuka do` already report via
// ConfigError/DuplicateStepError, so it propagates unchanged and
// src/cli/check.ts handles it exactly like every other command does
// (stderr + exit 1, no report). A malformed `.feature` file, in contrast, is
// this report's problem (`feature-parse-error`): one broken file must not
// stop every other feature's issues from being reported.

export async function analyzeProject(rootDir: string): Promise<CheckReport> {
  const config = await loadConfig(rootDir);
  const vocabulary = await discoverSteps(rootDir, config.featuresDir);

  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  const configResult = checkConfig(rootDir, config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  const bindingResult = checkBindings(vocabulary);
  errors.push(...bindingResult.issues);

  const { features, parseErrors } = loadFeatures(rootDir, config.featuresDir);
  for (const parseError of parseErrors) {
    errors.push({
      code: "feature-parse-error",
      message: parseError.message,
      file: parseError.relativePath,
    });
  }
  const featureResult = checkFeatures(features, vocabulary, bindingResult.patterns);
  errors.push(...featureResult.errors);
  warnings.push(...featureResult.warnings);

  return { errors, warnings };
}
