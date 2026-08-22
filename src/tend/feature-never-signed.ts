import { readFileSync } from "node:fs";
import path from "node:path";
import type { FeatureFile } from "../feature/load-features.js";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "A feature nothing has ever
// accepted" finding — every feature under featuresDir/additionalFeatureDirs
// (`features`, the exact set src/tend/analyze.ts already walked via
// loadFeaturesFromDirs for its own occurrence pass, never re-walked here)
// that no acceptance record (src/accept/render-record.ts's own output, read
// back by src/tend/record-parse.ts) names in its own `feature:`
// frontmatter. Every other sign-off finding here starts from a record and
// asks whether its claim still holds; this is the one that starts from a
// feature and asks whether a claim was ever made about it at all — the gap
// that sits behind "nobody ran `nuka accept`" leaving no trace anywhere
// else in this report.
//
// A note, not an error, unlike signoff-rot.ts's four staleness checks: a
// feature nothing has accepted yet is the ordinary state of one still being
// drafted (docs/spec.md "The acceptance loop" runs `check`/`run` more than
// once before `accept` ever happens), so treating this the way a stale
// claim is treated would turn every feature under active development into
// a red exit code for as long as it takes to finish it. No time threshold
// is applied either: "this feature is old enough that it should have been
// signed by now" is a guess this tool has no measurement to back
// (CLAUDE.md: a check that guesses is worse than no check), so this finding
// only ever answers "has a record ever named this feature", never "how
// long ago should it have".
//
// Unlike signoff-rot.ts/signoff-condition-mismatch.ts, a feature already
// inside `featuresDir` is not skipped: both of those skip a record whose
// feature runs unattended because the run itself now carries the
// guarantee that record once did, but "was this ever signed" is a
// different question from "is this frozen claim stale" — the placement
// skip was built to silence a comparison against a claim nothing depends
// on any more, and there is no such comparison here to silence.
//
// Distinct from signed-feature-unscanned.ts, which starts from the
// opposite end: a record that exists but names a feature outside the
// scanned set. This module never reads that one's output — it starts from
// `features` (already scanned) and asks whether each one has a record
// anywhere, so the two can never double-report the same feature: one has a
// record and the wrong scan membership, the other has the right scan
// membership and no record.
//
// A feature that failed to parse at all is not in `features` either
// (src/feature/load-features.ts collects a parse failure separately), so
// it is silently out of scope here the same way every other tend finding
// that reads `features` already is — a syntax error is `nuka check`'s own
// finding to report, not this one's.
//
// A record this module cannot parse (`parsed.kind !== "ok"`) is not
// counted as proof a feature was ever signed — the same choice
// signed-feature-unscanned.ts already makes for the same reason:
// signoff-rot.ts's own `signoff-record-unreadable` already covers a broken
// record, so trusting an unreadable claim here would silently paper over
// that same brokenness under a different finding's name.

export function findNeverSignedFeatures(rootDir: string, features: readonly FeatureFile[]): TendIssue[] {
  const signedFeaturePaths = new Set<string>();

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

    signedFeaturePaths.add(parsed.record.featurePath);
  }

  const issues: TendIssue[] = [];
  for (const feature of features) {
    if (signedFeaturePaths.has(feature.relativePath)) {
      continue;
    }
    issues.push({
      code: "feature-never-signed",
      message: `${feature.relativePath} has never been accepted: no acceptance record names it in its feature: frontmatter. Once a run of it is green, nuka accept ${feature.relativePath} freezes that run as its first sign-off.`,
      file: feature.relativePath,
    });
  }

  return issues;
}
