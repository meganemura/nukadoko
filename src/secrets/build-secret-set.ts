import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../context/env.js";
import { MIN_REDACTABLE_LENGTH, type SecretEntry, type SecretSet } from "./types.js";

// Responsibility: turn the envFiles classify-env-files.ts already decided
// are "secret sources" into the flat SecretSet redact.ts consumes — every
// key/value they define (later files winning, same merge order as
// context/env.ts's loadEnvFiles), minus `secrets.public` (m1-secrets task
// spec, decision 4: a key can be individually demoted, there is no
// promotion counterpart) and minus values shorter than
// MIN_REDACTABLE_LENGTH (excluded here rather than only in redact.ts — this
// task's spec scope leaves the choice open; doing it here means a value
// that will never be redacted also never becomes part of the SecretSet
// redact.ts has to scan).
//
// This reads and parses each secret-source file itself, sharing env.ts's
// own `parseEnvFile` rather than calling `loadEnvFiles`: this module only
// ever needs the secret-source subset of a run's configured envFiles, a
// different scope than the executor's own full-list merge for `ctx.env`
// (context/create-context.ts no longer loads env itself — see that
// module's header) — so the two merges are kept independent instead of
// forcing them through one shared pass.

export function buildSecretSet(
  rootDir: string,
  secretSourceFiles: readonly string[],
  publicKeys: readonly string[],
): SecretSet {
  let merged: Record<string, string> = {};
  for (const relativePath of secretSourceFiles) {
    let content: string;
    try {
      content = readFileSync(path.join(rootDir, relativePath), "utf8");
    } catch {
      // A configured file that doesn't exist on disk contributes no
      // secrets, mirroring loadEnvFiles' own tolerance for a missing file.
      continue;
    }
    merged = { ...merged, ...parseEnvFile(content) };
  }

  const publicSet = new Set(publicKeys);
  const entries: SecretEntry[] = [];
  for (const [name, value] of Object.entries(merged)) {
    if (publicSet.has(name) || value.length < MIN_REDACTABLE_LENGTH) {
      continue;
    }
    entries.push({ name, value });
  }
  return entries;
}
