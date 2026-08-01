import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { loadConfig } from "../config/load-config.js";
import {
  discoverSteps,
  type Vocabulary,
  type VocabularyEntry,
} from "../discover/discover-steps.js";
import { DuplicateStepError } from "../discover/errors.js";

// Responsibility: the one path both `nuka steps` and `nuka describe` share —
// load the project's config, then discover its vocabulary. Kept out of
// run-cli.ts so that path is unit-testable without going through yargs.

export async function loadVocabulary(rootDir: string): Promise<Vocabulary> {
  const config = await loadConfig(rootDir);
  return discoverSteps(rootDir, config.featuresDir);
}

export interface StepSummary {
  name: string;
  patterns: readonly string[];
  description: string;
  mutates: boolean;
}

export function summarize(entry: VocabularyEntry): StepSummary {
  return {
    name: entry.name,
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
  };
}

// Not `ReturnType<typeof z.toJSONSchema>`: that function is overloaded (a
// single-schema form and a registry form), and TS resolves ReturnType of an
// overloaded function to its *last* signature — the registry one, whose
// `{ schemas: ... }` shape is not what a single `z.toJSONSchema(schema)`
// call returns. A plain JSON-Schema-shaped record avoids depending on that
// resolution; the CLI only ever JSON.stringifies this value.
export type JsonSchema = Record<string, unknown>;

export interface StepContract extends StepSummary {
  args: JsonSchema;
  returns: JsonSchema;
}

export function describeContract(entry: VocabularyEntry): StepContract {
  return {
    ...summarize(entry),
    args: z.toJSONSchema(entry.step.args),
    returns: z.toJSONSchema(entry.step.returns),
  };
}

/**
 * Renders any error this CLI can encounter while loading a project's
 * vocabulary into a single line safe to print to stderr. ConfigError and
 * DuplicateStepError already carry a complete, specific message; anything
 * else (e.g. a syntax error thrown by importing a broken step file) falls
 * back to its own message.
 */
export function formatVocabularyError(error: unknown): string {
  if (error instanceof ConfigError || error instanceof DuplicateStepError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
