import { loadEnvFiles } from "../env/load-env-files.js";
import { MIN_REDACTABLE_LENGTH, type SecretEntry, type SecretSet } from "./types.js";

// Responsibility: turn secret-source envFiles (every value they define,
// minus `secrets.public`) plus any tracked-envFile key `secrets.redact`
// names anyway (origin
// and handling are separate questions — see config/schema.ts's `secrets`
// doc comment for the full reasoning) into the flat SecretSet redact.ts
// consumes — later files winning, same merge order as context/env.ts's
// loadEnvFiles — minus values shorter than MIN_REDACTABLE_LENGTH (excluded
// here rather than only in redact.ts: doing it here means a value that will
// never be redacted
// also never becomes part of the SecretSet redact.ts has to scan). The
// length floor applies identically to a `redact`-named key: a short value
// still can't be redacted without wrecking ordinary step record text, whether
// it got into this set by being untracked or by being named explicitly.
//
// The read-parse-merge is src/env/load-env-files.ts's `loadEnvFiles`.
// This module only ever needs subsets of a run's configured envFiles
// (secret sources, and the `redact`-named slice of tracked files). A
// subset is a shorter path list to that same function, not a second loop:
// a missing file and an unreadable file have to mean the same thing here
// and in `ctx.env`, or one of them can swallow a permission error the
// other reports.
//
// Options object rather than positional args: four same-shaped
// `readonly string[]` parameters are easy to
// pass in the wrong order silently — an options object makes every call
// site name what it's passing.

export interface BuildSecretSetOptions {
  /** envFiles classify-env-files.ts reported as secret sources: untracked,
   * ignored, or tracked but different from HEAD. Every key they define is
   * a secret unless demoted via `publicKeys`. */
  readonly secretSourceFiles: readonly string[];
  /** envFiles git does track. Normally contribute nothing to the
   * SecretSet — a tracked file's value is plain configuration by origin —
   * except for whichever of their keys `redactKeys` names. Defaults to
   * none. */
  readonly trackedFiles?: readonly string[];
  /** Secret-source keys to demote: present in the merged secret-source
   * values but excluded from the returned SecretSet. */
  readonly publicKeys: readonly string[];
  /** Tracked-file keys to promote into the SecretSet despite their tracked
   * origin (`secrets.redact`). Defaults to none. */
  readonly redactKeys?: readonly string[];
}

export function buildSecretSet(rootDir: string, options: BuildSecretSetOptions): SecretSet {
  const { secretSourceFiles, trackedFiles = [], publicKeys, redactKeys = [] } = options;

  const merged = loadEnvFiles(rootDir, secretSourceFiles);

  const redactSet = new Set(redactKeys);
  for (const [name, value] of Object.entries(loadEnvFiles(rootDir, trackedFiles))) {
    // Only a key `secrets.redact` explicitly names crosses over from a
    // tracked file — everything else a tracked file defines stays plain,
    // which is the whole point of git being the origin classifier.
    if (redactSet.has(name)) {
      merged[name] = value;
    }
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
