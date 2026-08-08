import { collectDefinedEnvKeys } from "../check/config-check.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "A secrets.public or
// secrets.redact entry naming a key no envFile defines" finding — moved
// here from src/check/config-check.ts's own `secrets-public-key-unknown`/
// `secrets-redact-key-unknown` warnings: a
// real instruction reaching nothing, but configuration drift, not something
// that changes whether this run should happen. Its two neighbors —
// `secrets-redact-key-too-short` and `tracked-secret-looking-key` — stay on
// `check`: both mean plaintext reaches a log the moment the run starts,
// which is worth knowing before the run rather than after.
//
// Detection is unchanged, only where it is read from: this reuses
// src/check/config-check.ts's own exported `collectDefinedEnvKeys`, the
// same envFile-key computation that file's own remaining
// `secrets-redact-key-too-short` check uses, so "which keys does any
// envFile define" can never quietly disagree between the two commands.

export function findUnknownSecretsKeys(rootDir: string, config: NukadokoConfig): TendIssue[] {
  const issues: TendIssue[] = [];
  const { allDefinedKeys } = collectDefinedEnvKeys(rootDir, config);

  for (const key of config.secrets.public) {
    if (!allDefinedKeys.has(key)) {
      issues.push({
        code: "secrets-public-key-unknown",
        message: `secrets.public names "${key}", which is not defined in any configured envFile`,
      });
    }
  }

  for (const key of config.secrets.redact) {
    if (!allDefinedKeys.has(key)) {
      issues.push({
        code: "secrets-redact-key-unknown",
        message: `secrets.redact names "${key}", which is not defined in any configured envFile`,
      });
    }
  }

  return issues;
}
