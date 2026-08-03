import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFiles, parseEnvFile } from "../context/env.js";
import type { NukadokoConfig } from "../config/schema.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { MIN_REDACTABLE_LENGTH } from "../secrets/types.js";
import type { CheckIssue } from "./types.js";

// Responsibility: this task's spec's "config coherence" category (item 5) —
// featuresDir not existing on disk is the one error-level item; a
// configured envFile (top-level or per-environment) not existing, and a
// `secrets.public`/`secrets.redact` entry that names a key no configured
// envFile actually defines, are all warnings. The distinction matters:
// `do`/`run` are already tolerant of a missing envFile (loadEnvFiles just
// contributes nothing) and of a `secrets.public`/`secrets.redact` entry
// that never matches anything — check's job here is to surface that
// leniency, not turn it into a reason to fail (docs/spec.md "Secrets":
// redaction correctness at runtime is the real guarantee; this is
// visibility only).
//
// secrets-redact-and-warning task spec added two more items to that same
// visibility job:
//   - `secrets-redact-key-too-short`: a `secrets.redact` entry whose value
//     is under MIN_REDACTABLE_LENGTH never actually gets redacted
//     (build-secret-set.ts applies the same floor to every key regardless
//     of origin) — surfacing that, rather than letting an explicit
//     instruction silently do nothing, is the same reasoning as
//     `secrets-redact-key-unknown` below it.
//   - `tracked-secret-looking-key`: a tracked envFile defining a
//     secret-*looking* key (by name pattern) that isn't in
//     `secrets.redact`. This is the one check category in this file that
//     is a heuristic rather than a derived fact — unlike everything above
//     it, "looks like a secret" is a guess about a key's *name*, not a
//     property this module can verify. That guess is used for exactly one
//     purpose: deciding whether to emit this warning. It never feeds back
//     into whether anything is actually redacted — that decision stays
//     entirely with git's tracked/untracked classification plus
//     `secrets.redact`, in build-secret-set.ts, unchanged by this file.
//     Requires classifying envFiles (classifyEnvFiles, async) — the reason
//     this function itself is now async.

export interface ConfigCheckResult {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}

// Case-insensitive partial match for the four keyword substrings; `KEY` is
// deliberately narrower (only as its own underscore-delimited token, or the
// whole name) so a plain substring check doesn't also fire on a name that
// merely happens to contain the letters "key", like "MONKEY" or "KEYWORD".
const SECRET_LOOKING_KEY_PATTERN = /SECRET|PASSWORD|TOKEN|CREDENTIAL|_KEY|^KEY$/i;

function looksLikeSecretKey(key: string): boolean {
  return SECRET_LOOKING_KEY_PATTERN.test(key);
}

export async function checkConfig(
  rootDir: string,
  config: NukadokoConfig,
): Promise<ConfigCheckResult> {
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
  const allEnvFiles = [...(config.envFiles ?? []), ...environmentEnvFiles];
  const allDefinedEnv = loadEnvFiles(rootDir, allEnvFiles);
  const allDefinedKeys = new Set(Object.keys(allDefinedEnv));
  for (const key of config.secrets.public) {
    if (!allDefinedKeys.has(key)) {
      warnings.push({
        code: "secrets-public-key-unknown",
        message: `secrets.public names "${key}", which is not defined in any configured envFile`,
      });
    }
  }

  for (const key of config.secrets.redact) {
    if (!allDefinedKeys.has(key)) {
      warnings.push({
        code: "secrets-redact-key-unknown",
        message: `secrets.redact names "${key}", which is not defined in any configured envFile`,
      });
      continue;
    }
    // Non-null: `key` just passed the allDefinedKeys.has check above, and
    // allDefinedKeys is exactly Object.keys(allDefinedEnv).
    if (allDefinedEnv[key]!.length < MIN_REDACTABLE_LENGTH) {
      warnings.push({
        code: "secrets-redact-key-too-short",
        message: `secrets.redact names "${key}", but its value is shorter than ${MIN_REDACTABLE_LENGTH} characters, so build-secret-set.ts will never actually redact it`,
      });
    }
  }

  // Which of allEnvFiles git tracks — needed only for the heuristic warning
  // below; a classification failure (no git, rootDir outside a repository)
  // falls back to "every file is a secret source" (classifyEnvFiles' own
  // safe default), which here just means `tracked` comes back empty and
  // this loop finds nothing to warn about.
  const classification = await classifyEnvFiles(rootDir, allEnvFiles);
  const redactKeys = new Set(config.secrets.redact);
  for (const relativePath of classification.tracked) {
    let content: string;
    try {
      content = readFileSync(path.join(rootDir, relativePath), "utf8");
    } catch {
      continue;
    }
    for (const key of Object.keys(parseEnvFile(content))) {
      if (redactKeys.has(key) || !looksLikeSecretKey(key)) {
        continue;
      }
      warnings.push({
        code: "tracked-secret-looking-key",
        message: `"${key}" in "${relativePath}" looks like a secret by name, but that file is tracked by git so its value is not redacted; add "${key}" to secrets.redact if it should be`,
        file: relativePath,
      });
    }
  }

  return { errors, warnings };
}
