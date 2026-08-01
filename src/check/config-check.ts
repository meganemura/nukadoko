import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFiles } from "../context/env.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { CheckIssue } from "./types.js";

// Responsibility: this task's spec's "config coherence" category (item 5) —
// featuresDir not existing on disk is the one error-level item; a
// configured envFile (top-level or per-environment) not existing, and a
// `secrets.public` entry that names a key no configured envFile actually
// defines, are both warnings. The distinction matters: `do`/`run` are
// already tolerant of a missing envFile (loadEnvFiles just contributes
// nothing) and of a `secrets.public` entry that never matches anything —
// check's job here is to surface that leniency, not turn it into a reason
// to fail (docs/spec.md "Secrets": redaction correctness at runtime is the
// real guarantee; this is visibility only).

export interface ConfigCheckResult {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}

export function checkConfig(rootDir: string, config: NukadokoConfig): ConfigCheckResult {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  const featuresRoot = path.join(rootDir, config.featuresDir);
  if (!existsSync(featuresRoot)) {
    errors.push({
      code: "features-dir-missing",
      message: `featuresDir "${config.featuresDir}" does not exist at ${featuresRoot}`,
    });
  }

  for (const relativePath of config.envFiles ?? []) {
    if (!existsSync(path.join(rootDir, relativePath))) {
      warnings.push({
        code: "env-file-missing",
        message: `envFile "${relativePath}" does not exist`,
        file: relativePath,
      });
    }
  }

  const environmentEnvFiles: string[] = [];
  for (const [environmentName, environmentConfig] of Object.entries(config.environments ?? {})) {
    for (const relativePath of environmentConfig.envFiles ?? []) {
      environmentEnvFiles.push(relativePath);
      if (!existsSync(path.join(rootDir, relativePath))) {
        warnings.push({
          code: "environment-env-file-missing",
          message: `environments.${environmentName}.envFiles names "${relativePath}", which does not exist`,
          file: relativePath,
        });
      }
    }
  }

  // Every key any configured envFile defines, across the top-level list and
  // every environment's own list — loadEnvFiles already tolerates a missing
  // file (contributes nothing), so this reuses it rather than re-parsing.
  const allDefinedKeys = new Set(
    Object.keys(loadEnvFiles(rootDir, [...(config.envFiles ?? []), ...environmentEnvFiles])),
  );
  for (const key of config.secrets.public) {
    if (!allDefinedKeys.has(key)) {
      warnings.push({
        code: "secrets-public-key-unknown",
        message: `secrets.public names "${key}", which is not defined in any configured envFile`,
      });
    }
  }

  return { errors, warnings };
}
