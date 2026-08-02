import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { loadFeatures, parseFeatureSource, type LoadFeaturesResult } from "../feature/load-features.js";
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
//
// m5b-check-feature-arg task spec: `featureArg`, when given, *replaces*
// which feature(s) get checked — the `featuresDir` walk above is skipped
// entirely in favor of that one file (not added to it: an existing error
// under `featuresDir` would otherwise bury the very feature this argument
// exists to single out). `discoverSteps` above is untouched by this
// parameter (config/binding checks and the vocabulary they check features
// against always come from `featuresDir`, spec's own decision) — only the
// `loadFeatures` call below is conditional. A `featureArg` that doesn't
// exist or can't be read is a usage mistake, not a project finding: it
// throws `CheckFeatureNotFoundError` (message pre-formatted "nuka check: …",
// same tone as `nuka accept`'s own hand-written stderr messages) rather than
// becoming a `feature-parse-error` report entry, and src/cli/check.ts's
// existing catch-all (already used for ConfigError/DuplicateStepError)
// turns it into stderr + exit 1 unchanged. A file that *does* exist but
// fails to parse, by contrast, stays a `feature-parse-error` report entry —
// the same category a broken file under `featuresDir` gets — since that is
// a real property of the feature file itself, not a bad argument.

export class CheckFeatureNotFoundError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`nuka check: feature file not found: ${relativePath}`);
    this.name = "CheckFeatureNotFoundError";
    this.relativePath = relativePath;
  }
}

// Path resolution matches `nuka run`/`nuka accept` (relative to `rootDir`,
// absolute paths accepted as-is) — this task's spec, decision 4. No `:line`
// support (spec, same decision): check is a static analysis over a whole
// file, not one scenario.
function loadSingleFeature(rootDir: string, featureArg: string): LoadFeaturesResult {
  const relativePath = path.relative(rootDir, path.resolve(rootDir, featureArg));
  const absolutePath = path.join(rootDir, relativePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    throw new CheckFeatureNotFoundError(relativePath);
  }

  try {
    const { pickles } = parseFeatureSource(source, relativePath);
    return { features: [{ relativePath, pickles }], parseErrors: [] };
  } catch (error) {
    return {
      features: [],
      parseErrors: [
        { relativePath, message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export async function analyzeProject(rootDir: string, featureArg?: string): Promise<CheckReport> {
  const config = await loadConfig(rootDir);
  const { vocabulary, compatParameterTypes } = await discoverSteps(rootDir, config.featuresDir);

  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  const configResult = checkConfig(rootDir, config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  const bindingResult = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  errors.push(...bindingResult.issues);
  warnings.push(...bindingResult.warnings);

  const { features, parseErrors } =
    featureArg === undefined ? loadFeatures(rootDir, config.featuresDir) : loadSingleFeature(rootDir, featureArg);
  for (const parseError of parseErrors) {
    errors.push({
      code: "feature-parse-error",
      message: parseError.message,
      file: parseError.relativePath,
    });
  }
  const featureResult = checkFeatures(features, vocabulary, bindingResult.patterns, config.parameterTypes);
  errors.push(...featureResult.errors);
  warnings.push(...featureResult.warnings);

  return { errors, warnings };
}
