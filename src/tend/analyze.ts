import { checkBindings } from "../check/binding-check.js";
import { loadConfig } from "../config/load-config.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { loadFeaturesFromDirs } from "../feature/load-features.js";
import { findMissingAdditionalFeatureDirs } from "./additional-feature-dir-missing.js";
import { findFixturesTouchingApp } from "./fixture-touches-app.js";
import { findUnusedFixtures } from "./fixture-unused.js";
import { findUnusedFromDeclarations } from "./from-unused.js";
import { findImportFailuresUnseen } from "./import-failures-unseen.js";
import { analyzeFieldDescriptions } from "./missing-describe.js";
import { findMissingRationale } from "./missing-rationale.js";
import { findSupportOriginParameterTypes } from "./parameter-type-support-origin.js";
import { findUnboundPatternedSteps } from "./pattern-unbound.js";
import { findUnknownSecretsKeys } from "./secrets-unknown-key.js";
import { findSignedFeatureUnscanned } from "./signed-feature-unscanned.js";
import { findSignoffConditionMismatch } from "./signoff-condition-mismatch.js";
import { findSignoffRot } from "./signoff-rot.js";
import { resolveStepOccurrences } from "./step-bindings.js";
import { buildTendSummary } from "./summary.js";
import { findUnusedParameterTypes } from "./unused-parameter-type.js";
import type { TendIssue, TendReport } from "./types.js";

// Responsibility: the one function `nuka tend` runs — load the project the
// same way `nuka check` does (loadConfig, discoverSteps, loadFeaturesFromDirs)
// and run every note-only finding, in the fixed order below so a human
// reading text output sees findings grouped by kind without this module
// needing to sort anything after the fact (this task's spec: text output
// "種類ごとにまとまっていること" — src/cli/tend.ts pushes each category's
// array through in one block rather than interleaving). `findUnusedFixtures`/
// `findFixturesTouchingApp` are P5's own two additions (task spec, scope
// item 9) — `fixtureGraph` (`buildFixtureGraph`, src/fixture/graph.ts) is
// built once, here, and passed to both, the same "never a second computation
// path" rule `patterns` just below already follows for `checkBindings`. Two
// of
// the nine — `findSupportOriginParameterTypes` and `findUnknownSecretsKeys`
// — did not start here: they were `nuka check` warnings
// (`parameter-type-support-origin`, `secrets-public-key-unknown`/
// `secrets-redact-key-unknown`) that m8d-move-to-tend reclassified, on the
// same "does this have to be known before the run" test docs/spec.md
// "Tending" states — their own detection logic is untouched, only where a
// caller reads the finding from. Two more —
// `findMissingAdditionalFeatureDirs` and `findSignedFeatureUnscanned` — are
// fb3-scan-dirs's own additions: the first reports a configured-but-absent
// `additionalFeatureDirs` entry, the second makes visible the exact gap this
// task spec exists to close — an accepted feature outside every scanned
// directory, which is what made `pattern-unbound` misreport a bound step as
// unbound before `additionalFeatureDirs` existed to name where it lives.
//
// `patterns` is built once, here, via src/check/binding-check.ts's own
// `checkBindings` — the same parsed-pattern array src/check/feature-check.ts
// and src/check/from-order.ts already consume — never rebuilt (this task's
// spec: "三つ目の計算経路を作らない"). Its own `issues`/`warnings` are
// discarded: those are `check`'s findings, not tend's, and a binding error
// (e.g. a broken custom parameter type) just means `patterns` comes back
// empty, which every finding below already treats as "nothing to check"
// rather than crashing.
//
// `discoverSteps` runs tolerant of a broken glue file (`tolerateImportFailures:
// true`, the same flag src/check/analyze.ts passes) so one unreadable step
// file doesn't take down every other finding across the rest of the
// project — the same migrating-suite reasoning that file's own header
// gives. Per-file verdicts on *why* a file failed still stay `check`'s own
// finding (`step-file-import-failed`); this module only says, once, that
// some steps went unseen (`findImportFailuresUnseen` below, fb5-loader-
// visibility task spec, decision 4) — silently having fewer steps to look
// at, with nothing here saying so, is exactly the failure CLAUDE.md's
// "Nothing breaks silently" rules out. It is still called with
// `config.featuresDir` alone, unchanged by fb3-scan-dirs: only
// `loadFeaturesFromDirs` below widens to include
// `additionalFeatureDirs` — the vocabulary a step pattern is checked against
// is a different question from which feature files get walked for
// occurrences (src/check/analyze.ts's own header makes the same split).
//
// `errors` is populated by `findSignoffRot` alone (m8b-tend-signoff-rot task
// spec): sign-off staleness is the one docs/spec.md "Tending" finding marked
// as an error rather than a note (a record that has quietly stopped meaning
// what it says is worse than no record, because it is still being counted),
// and it is the only tend finding that reads outside `vocabulary`/
// `features` — it walks the whole project for acceptance records
// (src/tend/record-parse.ts) and checks each one against this same
// `vocabulary`, never a second one it builds itself.
//
// `summary` (m8c-tend-summary task spec, extended by fb3-scan-dirs) is built
// from the same `vocabulary` plus `rationaleIssues`/`fieldDescriptions`,
// both already computed above for `notes`, plus `scannedFeatureDirs` (the
// same `featuresDir` + `additionalFeatureDirs` list `loadFeaturesFromDirs`
// was called with) — it is where the bed currently is, not a finding, so it
// never feeds `errors` or `notes` and never changes the caller's exit code
// (src/cli/tend.ts still derives that from `errors` alone).
//
// `findSignoffConditionMismatch` is accept-condition's own addition (task
// spec, item 7) — a note, not an error, unlike `findSignoffRot` just above:
// nothing about a sign-off's own claim has gone stale (that is still
// `findSignoffRot`'s exclusive question), only that a *different* condition
// is what `nuka accept` would now pick for this feature. It shares
// `findSignoffRot`'s own record-walking source (src/tend/record-parse.ts)
// but does its own independent walk of it (that file's own header) rather
// than being folded into `findSignoffRot`'s loop, since one produces
// `errors` and the other `notes` — never the same collection.

export async function analyzeTend(rootDir: string): Promise<TendReport> {
  const config = await loadConfig(rootDir);
  const { vocabulary, compatParameterTypes, importFailures } = await discoverSteps(
    rootDir,
    config.featuresDir,
    { tolerateImportFailures: true },
  );

  const { patterns } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  const scannedFeatureDirs = [config.featuresDir, ...config.additionalFeatureDirs];
  const { features, missingAdditionalDirs } = loadFeaturesFromDirs(
    rootDir,
    config.featuresDir,
    config.additionalFeatureDirs,
  );
  const occurrences = resolveStepOccurrences(features, patterns);

  const errors: TendIssue[] = [...findSignoffRot(rootDir, vocabulary)];

  // Called once each, their results reused for both `notes` below and the
  // summary's declaration-coverage numbers (m8c-tend-summary task spec:
  // "二度数えないこと") — never re-walked a second time just to count.
  const rationaleIssues = findMissingRationale(vocabulary);
  const fieldDescriptions = analyzeFieldDescriptions(vocabulary);
  const fixtureGraph = buildFixtureGraph(config);

  const notes: TendIssue[] = [
    ...findImportFailuresUnseen(importFailures),
    ...findUnusedFromDeclarations(vocabulary, occurrences),
    ...findUnboundPatternedSteps(vocabulary, occurrences),
    ...fieldDescriptions.issues,
    ...rationaleIssues,
    ...findUnusedParameterTypes(vocabulary, config.parameterTypes),
    ...findSupportOriginParameterTypes(compatParameterTypes),
    ...findUnknownSecretsKeys(rootDir, config),
    ...findMissingAdditionalFeatureDirs(missingAdditionalDirs),
    ...findSignedFeatureUnscanned(rootDir, scannedFeatureDirs),
    ...findUnusedFixtures(vocabulary, fixtureGraph),
    ...findFixturesTouchingApp(fixtureGraph),
    ...findSignoffConditionMismatch(rootDir, config.browserType),
  ];

  const summary = buildTendSummary(vocabulary, rationaleIssues.length, fieldDescriptions, scannedFeatureDirs);

  return { errors, notes, summary };
}
