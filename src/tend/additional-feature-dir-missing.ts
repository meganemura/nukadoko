import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md fb3-scan-dirs task spec's decision 2 — an
// `additionalFeatureDirs` entry that does not exist on disk. It was named
// specifically to widen what `nuka check`/`nuka tend` scan, so a typo or a
// removed directory left behind in config is a config mistake, the same way
// `featuresDir` not existing is (src/check/config-check.ts's own
// `features-dir-missing`, an error there) — but `tend` has no error bucket
// for config mistakes, only `signoff-rot` (src/tend/types.ts's own header),
// so this is a note here, matching every other tend finding's severity
// except that one.
//
// `missingDirs` is `loadFeaturesFromDirs`'s own answer
// (src/feature/load-features.ts) — this module only turns that list into
// tend's `TendIssue` shape, never re-derives directory existence itself, so
// a missing-directory bug can only ever be one bug, not two disagreeing
// ones.

export function findMissingAdditionalFeatureDirs(missingDirs: readonly string[]): TendIssue[] {
  return missingDirs.map((dir) => ({
    code: "additional-feature-dir-missing",
    message: `additionalFeatureDirs names "${dir}", which does not exist — a directory named in config to widen what is scanned but absent from disk is a config mistake, not an empty scan result.`,
    file: dir,
  }));
}
