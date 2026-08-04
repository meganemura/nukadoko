import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md fb3-scan-dirs task spec's decision 4 — a
// feature with a sign-off record on disk (src/accept/render-record.ts is the
// only writer) whose own path falls outside every directory `nuka check`/
// `nuka tend` actually scan (`featuresDir` + `additionalFeatureDirs`). This
// is the exact situation this whole task spec exists for
// (skills/acceptance/SKILL.md recommends an accepted feature live outside
// `featuresDir`, so `pattern-unbound` calls its steps unbound unless the
// feature's own directory is named in `additionalFeatureDirs`) — this
// finding is what makes that gap visible from `tend`'s own output instead of
// staying a silent false positive on a different finding.
//
// Deliberately *not* used to decide what gets scanned (this task's spec,
// decision 4's own "判定に使わない理由"): reading sign-off records to expand
// the scanned set would only ever notice a feature that has already been
// accepted at least once, silently missing one still being drafted —
// exactly the feature a false `pattern-unbound` would most mislead someone
// about. So this reads sign-off records for visibility only; the scanned set
// itself always comes from `scannedFeatureDirs`, computed from config alone
// (src/tend/analyze.ts).
//
// Severity is `note`, not `error` (this task's spec, decision 4): unlike
// `signoff-rot`'s findings, nothing here is a record that has stopped being
// true — the record may be perfectly accurate, it is simply proving a claim
// about a feature nothing else in the report is currently looking at.
//
// One note per feature path, not per record file: a feature can be
// re-accepted more than once, and a reader gains nothing from seeing the
// same "not scanned" fact repeated once per record.

function isWithinScannedDirs(featurePath: string, scannedFeatureDirs: readonly string[]): boolean {
  return scannedFeatureDirs.some((dir) => {
    const relative = path.relative(dir, featurePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

export function findSignedFeatureUnscanned(
  rootDir: string,
  scannedFeatureDirs: readonly string[],
): TendIssue[] {
  const issues: TendIssue[] = [];
  const seenFeaturePaths = new Set<string>();

  for (const absolutePath of discoverMarkdownFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Removed between the walk and this read — nothing to report.
    }

    const parsed = parseAcceptanceRecord(content, relativePath);
    if (parsed.kind !== "ok") {
      continue; // Not a record, or malformed — signoff-rot.ts's own concern, not this finding's.
    }

    const { featurePath } = parsed.record;
    if (seenFeaturePaths.has(featurePath) || isWithinScannedDirs(featurePath, scannedFeatureDirs)) {
      continue;
    }
    seenFeaturePaths.add(featurePath);

    issues.push({
      code: "signed-feature-unscanned",
      message: `${featurePath} has an accepted sign-off record, but it is outside every directory nuka check/nuka tend scan (featuresDir + additionalFeatureDirs). Steps it binds can be reported as unbound (pattern-unbound) even though this feature genuinely binds them. Add its directory to additionalFeatureDirs.`,
      file: featurePath,
    });
  }

  return issues;
}
