import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFiles, parseEnvFile } from "../context/env.js";
import { skippedEnvFileLines } from "../env/parse-env-file.js";
import { resolveConfigFileName } from "../config/load-config.js";
import type { NukadokoConfig } from "../config/schema.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { MIN_REDACTABLE_LENGTH } from "../secrets/types.js";
import { shellWord } from "../shell/shell-word.js";
import type { CheckIssue } from "./types.js";

// Responsibility: config coherence —
// featuresDir not existing on disk is one error-level item (joined by
// the additionalFeatureDirs-missing check below, same severity and
// same reasoning: a directory named in config to be scanned and absent from
// disk is a config mistake, not a leniency to extend); a configured envFile
// (top-level or per-environment) not existing is a warning. The distinction
// there matters: `do`/`run` are already tolerant of a missing envFile
// (loadEnvFiles contributes nothing for ENOENT). check's job here is to
// surface that leniency, not turn it into a reason to fail (docs/spec.md
// "Sessions, environments, secrets": the executor redacts when it writes a
// record surface; this warning is visibility only).
//
// That same
// visibility job also covers `secrets-redact-key-too-short`: a `secrets.redact` entry
// whose value is under MIN_REDACTABLE_LENGTH and so never actually gets
// redacted (build-secret-set.ts applies the same floor to every key
// regardless of origin) — surfacing that, rather than letting an explicit
// instruction silently do nothing, is check's job because plaintext then
// reaches a log the moment the run starts.
//
// `secrets-public-key-unknown` and `secrets-redact-key-unknown` — a
// `secrets.public`/`secrets.redact` entry naming a key no configured
// envFile defines at all — used to live here too, as warnings. They moved
// to src/tend/secrets-unknown-key.ts: neither
// changes whether a run should happen, unlike their `-too-short` neighbor
// above, which means plaintext reaches a log immediately. `collectDefinedEnvKeys`
// below is exported so that module can answer "which keys does any envFile
// define" the exact same way this file's own `secrets-redact-key-too-short`
// check does, rather than re-deriving it.
//
// `tracked-secret-looking-key`: a tracked envFile defining a
// secret-*looking* key (by name pattern) that isn't in `secrets.redact`.
// This is the one check category in this file that is a heuristic rather
// than a derived fact — unlike everything above it, "looks like a secret"
// is a guess about a key's *name*, not a property this module can verify.
// That guess is used for exactly one purpose: deciding whether to emit this
// warning. It never feeds back into whether anything is actually redacted —
// that decision stays entirely with git's classification (untracked,
// ignored, or a tracked file that differs from HEAD, versus one that
// matches HEAD) plus `secrets.redact`, in build-secret-set.ts, unchanged
// by this file.
// Requires classifying envFiles (classifyEnvFiles, async) — the reason this
// function itself is now async.

export interface ConfigCheckResult {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}

/** Every key any configured envFile defines, across the top-level list and
 * every environment's own list, plus the flattened list of envFile paths
 * itself. loadEnvFiles tolerates a missing file (contributes nothing) and
 * throws for any other read error, naming the path and the errno, so a
 * directory or an unreadable file is reported here rather than looking like
 * a file that defines no keys. Shared by this file's own
 * `secrets-redact-key-too-short` check and src/tend/secrets-unknown-key.ts's
 * `secrets-public-key-unknown`/`secrets-redact-key-unknown` findings, so
 * "which keys exist" can never quietly disagree between the two. */
export function collectDefinedEnvKeys(
  rootDir: string,
  config: NukadokoConfig,
): {
  readonly allEnvFiles: readonly string[];
  readonly allDefinedEnv: Record<string, string>;
  readonly allDefinedKeys: ReadonlySet<string>;
} {
  const environmentEnvFiles: string[] = [];
  for (const environmentConfig of Object.values(config.environments ?? {})) {
    environmentEnvFiles.push(...(environmentConfig.envFiles ?? []));
  }
  const allEnvFiles = [...(config.envFiles ?? []), ...environmentEnvFiles];
  const allDefinedEnv = loadEnvFiles(rootDir, allEnvFiles);
  return { allEnvFiles, allDefinedEnv, allDefinedKeys: new Set(Object.keys(allDefinedEnv)) };
}

// Case-insensitive partial match for the four keyword substrings; `KEY` is
// deliberately narrower (only as a whole underscore-delimited token) so a
// plain substring check doesn't also fire on a name that merely contains the
// letters "key", like "MONKEY", "KEYWORD", or "MAX_KEYS_PER_PAGE". A name that
// fuses the word into one token ("APIKEY") is not matched either: a warning
// that guesses is worse than none.
const SECRET_LOOKING_KEY_PATTERN = /SECRET|PASSWORD|TOKEN|CREDENTIAL|(?:^|_)KEY(?:_|$)/i;

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_LOOKING_KEY_PATTERN.test(key);
}

export async function checkConfig(
  rootDir: string,
  config: NukadokoConfig,
): Promise<ConfigCheckResult> {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const configFile = resolveConfigFileName(rootDir);

  const featuresRoot = path.join(rootDir, config.featuresDir);
  if (!existsSync(featuresRoot)) {
    errors.push({
      code: "features-dir-missing",
      message: `featuresDir "${config.featuresDir}" does not exist at ${featuresRoot}`,
      file: configFile,
      do: `mkdir -p ${shellWord(path.posix.join(config.featuresDir, "steps"))}, or correct featuresDir in ${configFile}`,
    });
  }

  // Same error-level treatment as featuresDir above, one entry at a time:
  // additionalFeatureDirs is named
  // specifically to widen what nuka check/tend scan, so an entry that
  // doesn't exist is a config mistake to report, not an empty answer to
  // fail open on — src/feature/load-features.ts's loadFeaturesFromDirs
  // already treats it that way; this is check's own report of the same
  // fact for the no-argument default path.
  for (const relativePath of config.additionalFeatureDirs) {
    const absolutePath = path.join(rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      errors.push({
        code: "additional-feature-dir-missing",
        message: `additionalFeatureDirs names "${relativePath}", which does not exist at ${absolutePath}`,
        file: relativePath,
        do: `mkdir -p ${shellWord(relativePath)}, or remove ${JSON.stringify(relativePath)} from additionalFeatureDirs in ${configFile}.`,
      });
    }
  }

  for (const relativePath of config.envFiles ?? []) {
    if (!existsSync(path.join(rootDir, relativePath))) {
      warnings.push({
        code: "env-file-missing",
        message: `envFile "${relativePath}" does not exist`,
        file: relativePath,
        do: `Create ${relativePath}, or remove ${JSON.stringify(relativePath)} from envFiles in ${configFile}.`,
      });
    }
  }

  for (const [environmentName, environmentConfig] of Object.entries(config.environments ?? {})) {
    for (const relativePath of environmentConfig.envFiles ?? []) {
      if (!existsSync(path.join(rootDir, relativePath))) {
        warnings.push({
          code: "environment-env-file-missing",
          message: `environments.${environmentName}.envFiles names "${relativePath}", which does not exist`,
          file: relativePath,
          do: `Create ${relativePath}, or remove ${JSON.stringify(relativePath)} from environments.${environmentName}.envFiles in ${configFile}.`,
        });
      }
    }
  }

  const { allEnvFiles, allDefinedEnv, allDefinedKeys } = collectDefinedEnvKeys(rootDir, config);

  // The same files loadEnvFiles just parsed. A line that did not become a
  // binding is still invisible to the run. Name it here. The text stays
  // out of the message: a skipped line is often the secret that failed to
  // parse, and check does not print secret values.
  const reportedEnvFiles = new Set<string>();
  for (const relativePath of allEnvFiles) {
    if (reportedEnvFiles.has(relativePath)) continue;
    reportedEnvFiles.add(relativePath);
    const absolutePath = path.join(rootDir, relativePath);
    if (!existsSync(absolutePath)) continue;
    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    for (const line of skippedEnvFileLines(content)) {
      warnings.push({
        code: "env-file-skipped-line",
        message: `envFile "${relativePath}" line ${line} was skipped, so nothing on it was loaded`,
        file: relativePath,
        line,
      });
    }
  }

  for (const key of config.secrets.redact) {
    if (!allDefinedKeys.has(key)) {
      // Undefined — src/tend/secrets-unknown-key.ts's
      // secrets-redact-key-unknown reports it now; nothing about it
      // changes whether this run should happen.
      continue;
    }
    // Non-null: `key` just passed the allDefinedKeys.has check above, and
    // allDefinedKeys is exactly Object.keys(allDefinedEnv).
    if (allDefinedEnv[key]!.length < MIN_REDACTABLE_LENGTH) {
      warnings.push({
        code: "secrets-redact-key-too-short",
        message: `secrets.redact names "${key}", but its value is shorter than ${MIN_REDACTABLE_LENGTH} characters, so build-secret-set.ts will never actually redact it`,
        file: configFile,
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
