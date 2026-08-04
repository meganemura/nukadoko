import { readFileSync } from "node:fs";
import path from "node:path";
import { formatValidationIssues } from "../binding/format-issues.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s first, error-level finding — a
// sign-off that no longer matches the code it froze. This is the one
// finding m8a left `errors` empty for (src/tend/types.ts's own header): a
// record proves a claim ("this feature was green at this commit, and here
// is the evidence"), and unlike the other five tend findings, a record that
// has quietly stopped being true is worse than no record at all, because it
// is still being counted as proof.
//
// Four ways a record can go stale, all checked here, all `error`:
//   (a) the feature it names no longer exists.
//   (b) the feature source it froze no longer matches the file (exact
//       string comparison — see `normalizeFeatureSource`'s own comment for
//       the one normalization allowed).
//   (c) a step it cites is gone from the current vocabulary.
//   (d) a step's frozen `result` no longer passes that step's current
//       `returns` schema.
// Checked independently per record, not short-circuited on the first
// failure — a record with a missing feature can still cite a step whose
// contract also changed, and reporting only the first would hide the
// second until the first is fixed and `tend` is run again.
//
// (c)/(d) skip a compat vocabulary entry (`entry.kind !== "typed"`): compat
// has no `returns` schema at all, so "does the frozen result still pass it"
// has no question to ask — the same reason `render-record.ts`'s own
// "Declared vs observed" section keeps a compat step's `mutates: null` out
// of its mismatch count instead of coercing it to "no mismatch". A receipt
// whose own `status` isn't `"ok"` is skipped the same way (defensive: `nuka
// accept` only ever freezes a passed scenario, so this should not occur in
// practice).
//
// Every message here points at how to fix it — re-run and re-accept, or
// revert whatever changed — and never at hand-editing the record itself:
// docs/spec.md is explicit that a hand-edited record just goes back to
// being a claim, which is exactly the failure mode this finding exists to
// catch.

const FIX_HINT = "re-run `nuka run` and `nuka accept` to refreeze it, or revert whatever changed since it was accepted";

// The one normalization allowed (this task's spec, constraints): a feature
// file always ends in its own trailing newline, and `render-record.ts`
// strips exactly one before embedding it (its own comment: "the fence's own
// closing ``` already supplies that break"). Applying the identical
// `.replace` to the freshly-read file, rather than e.g. `.trim()`ing both
// sides, is what keeps this comparison from forgiving a real difference
// (leading whitespace, a second blank line) that "the fence already
// supplies a break" was never meant to cover.
function normalizeFeatureSource(source: string): string {
  return source.replace(/\n$/, "");
}

export function findSignoffRot(rootDir: string, vocabulary: Vocabulary): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const absolutePath of discoverMarkdownFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Removed between the walk and this read — nothing to report.
    }

    const parsed = parseAcceptanceRecord(content, relativePath);
    if (parsed.kind === "not-a-record") {
      continue; // Ordinary Markdown — the expected case for most `.md` files.
    }
    if (parsed.kind === "malformed") {
      issues.push({
        code: "signoff-record-unreadable",
        message: `${relativePath} looks like an acceptance record (its frontmatter has run_id/commit/feature/scenarios) but could not be read: ${parsed.reason}. A broken record reads as healthy if it is silently skipped, so this is reported instead: ${FIX_HINT}.`,
        file: relativePath,
      });
      continue;
    }

    const record = parsed.record;

    // (a) the feature this record freezes.
    let currentFeatureSource: string | undefined;
    try {
      currentFeatureSource = readFileSync(path.join(rootDir, record.featurePath), "utf8");
    } catch {
      issues.push({
        code: "signoff-feature-missing",
        message: `${relativePath} freezes ${record.featurePath}, which no longer exists. The record is still proving a claim about a file that is gone. ${FIX_HINT}.`,
        file: relativePath,
      });
    }

    // (b) frozen source vs. what the file says now — only meaningful once
    // (a) has confirmed the file is still there.
    if (currentFeatureSource !== undefined && normalizeFeatureSource(currentFeatureSource) !== record.featureSource) {
      issues.push({
        code: "signoff-feature-changed",
        message: `${relativePath} froze ${record.featurePath} at a different state than the file has now. The record no longer describes what is on disk. ${FIX_HINT}.`,
        file: relativePath,
      });
    }

    // (c)/(d): every step this record cites, independent of (a)/(b) — a
    // step's own contract can go stale whether or not the feature that
    // exercised it is still intact.
    for (const receipt of record.receipts) {
      const entry = vocabulary.get(receipt.step);
      if (entry === undefined) {
        issues.push({
          code: "signoff-step-missing",
          message: `${relativePath} cites step "${receipt.step}", which is no longer in the vocabulary. The record is still proving a claim about a step that no longer exists. ${FIX_HINT}.`,
          file: relativePath,
          step: receipt.step,
        });
        continue;
      }
      if (entry.kind !== "typed") {
        continue; // Compat: no `returns` schema, so no contract to have gone stale.
      }
      if (receipt.status !== "ok") {
        continue; // Defensive: `nuka accept` only ever freezes a passed scenario.
      }
      const outcome = entry.step.returns.safeParse(receipt.result);
      if (!outcome.success) {
        issues.push({
          code: "signoff-result-invalid",
          message: `${relativePath} froze step "${receipt.step}"'s result, which no longer passes its current returns schema (${formatValidationIssues(outcome.error.issues)}). The step's contract changed since this record was accepted. ${FIX_HINT}.`,
          file: relativePath,
          step: receipt.step,
        });
      }
    }
  }

  return issues;
}
