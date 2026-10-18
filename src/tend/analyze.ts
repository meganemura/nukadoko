import { existsSync } from "node:fs";
import path from "node:path";
import { checkBindings } from "../check/binding-check.js";
import { loadConfig, resolveConfigFileName } from "../config/load-config.js";
import { rootRelativeStepFile } from "../check/unbound-patterned.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { loadFeaturesFromDirs } from "../feature/load-features.js";
import { findDescriptionTodos } from "./description-todo.js";
import { findFixturesReplacingBuiltins } from "./fixture-replaces-builtin.js";
import { findFixturesTouchingApp } from "./fixture-touches-app.js";
import { findUnusedFixtures } from "./fixture-unused.js";
import { findUnusedFromDeclarations } from "./from-unused.js";
import { findTypelessPackageJsons } from "./package-type-missing.js";
import { analyzeFieldDescriptions } from "./missing-describe.js";
import { findSupportOriginParameterTypes } from "./parameter-type-support-origin.js";
import { findUnboundPatternedSteps } from "./pattern-unbound.js";
import { findPostNavigationReads } from "./post-navigation-read.js";
import { findRepeatedScenarioPrefixes } from "./repeated-prefix.js";
import { findUnknownSecretsKeys } from "./secrets-unknown-key.js";
import { resolveStepOccurrences } from "./step-bindings.js";
import { buildTendSummary } from "./summary.js";
import { findUnusedParameterTypes } from "./unused-parameter-type.js";
import { tendCodeFix, type TendCode, type TendFinding, type TendIssue, type TendReport } from "./types.js";

// Findings about a config entry, which name the config file.
const CONFIG_ENTRY_CODES: ReadonlySet<TendCode> = new Set<TendCode>([
  "fixture-replaces-builtin",
  "fixture-touches-app",
  "fixture-unused",
  "parameter-type-unused",
  "secrets-public-key-unknown",
  "secrets-redact-key-unknown",
]);

// Responsibility: the one function `nuka tend` runs — load the project the
// same way `nuka check` does (loadConfig, discoverSteps, loadFeaturesFromDirs)
// and run every note-only finding, in the fixed order below so a human
// reading text output sees findings grouped by kind without this module
// needing to sort anything after the fact — src/cli/tend.ts pushes each
// category's array through in one block rather than interleaving.
// `fixtureGraph` (`buildFixtureGraph`, src/fixture/graph.ts) is built once,
// here, and passed to both fixture findings, the same "never a second
// computation path" rule `patterns` just below already follows for
// `checkBindings`. `findSupportOriginParameterTypes` and
// `findUnknownSecretsKeys` did not start here: they were `nuka check`
// warnings that were later reclassified, on the same "does this have to be
// known before the run" test docs/spec.md "Tending" states — their own
// detection logic is untouched, only where a caller reads the finding from.
// A configured-but-absent `additionalFeatureDirs` entry is `nuka check`'s
// error (`additional-feature-dir-missing`) and is not repeated here.
//
// `patterns` is built once, here, via src/check/binding-check.ts's own
// `checkBindings` — the same parsed-pattern array src/check/feature-check.ts
// and src/check/from-order.ts already consume — never a third computation
// path built to duplicate it. Its own `issues`/`warnings` are
// discarded: those are `check`'s findings, not tend's, and a binding error
// (e.g. a broken custom parameter type) just means `patterns` comes back
// empty, which every finding below already treats as "nothing to check"
// rather than crashing.
//
// `discoverSteps` runs tolerant of a broken glue file (`tolerateImportFailures:
// true`, the same flag src/check/analyze.ts passes) so one unreadable step
// file doesn't take down every other finding across the rest of the
// project — the same migrating-suite reasoning that file's own header
// gives. A file that failed to import is `check`'s finding
// (`step-file-import-failed`), and is not repeated here: a reader runs both
// commands, and one fact reported twice reads as two problems. It is still called with
// `config.featuresDir` alone, unchanged: only
// `loadFeaturesFromDirs` below widens to include
// `additionalFeatureDirs` — the vocabulary a step pattern is checked against
// is a different question from which feature files get walked for
// occurrences (src/check/analyze.ts's own header makes the same split).
//
// `errors` is always empty today. Every finding here is a note: a project is
// allowed to carry each of them, and `--fail-on` (src/cli/tend.ts) is how a
// team turns a chosen one red. The field stays in the report so a `--json`
// reader keeps one shape, and so a later finding that genuinely cannot be
// carried has somewhere to go without a breaking change.
//
// `summary` is built
// from the same `vocabulary` plus `fieldDescriptions`, already computed
// above for `notes`, plus `scannedFeatureDirs` (the
// same `featuresDir` + `additionalFeatureDirs` list `loadFeaturesFromDirs`
// was called with) — it is where the bed currently is, not a finding, so it
// never feeds `errors` or `notes` and never changes the caller's exit code
// (src/cli/tend.ts still derives that from `errors` alone).
//
// `findPostNavigationReads` is a note: nothing here is wrong right now, only
// a fact worth a human's attention (that module's own header explains why
// it is never a verdict). It walks `<stateDir>/records/steps/` directly, so
// `config.stateDir` is passed through to it rather than a
// `featuresDir`-shaped path. Every step record counts.
//
// `findTypelessPackageJsons` reads the config file and the step files the
// walk found, the files whose loads print Node's reparse warning.
//
// `findRepeatedScenarioPrefixes` also reads live records, but starts from
// the newest run.json. It reads only that run's scenarios before it reads
// the cited step records, so two runs never count the same scenario work
// twice.

function loadedConfigFile(rootDir: string): string[] {
  const fileName = resolveConfigFileName(rootDir);
  return existsSync(path.join(rootDir, fileName)) ? [fileName] : [];
}

export async function analyzeTend(rootDir: string): Promise<TendReport> {
  const config = await loadConfig(rootDir);
  const { vocabulary, compatParameterTypes, walkedFiles } = await discoverSteps(
    rootDir,
    config.featuresDir,
    { tolerateImportFailures: true },
  );

  const { patterns } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  const scannedFeatureDirs = [config.featuresDir, ...config.additionalFeatureDirs];
  const { features } = loadFeaturesFromDirs(
    rootDir,
    config.featuresDir,
    config.additionalFeatureDirs,
    config.oaths,
  );
  const occurrences = resolveStepOccurrences(features, patterns);

  const errors: TendIssue[] = [];

  // Called once, its result reused for both `notes` below and the
  // summary's declaration-coverage number — never re-walked a second time
  // just to count.
  const fieldDescriptions = analyzeFieldDescriptions(vocabulary);
  const fixtureGraph = buildFixtureGraph(config);

  const notes: TendIssue[] = [
    ...findUnusedFromDeclarations(vocabulary, occurrences),
    ...findUnboundPatternedSteps(vocabulary, occurrences, rootDir),
    ...findDescriptionTodos(vocabulary, rootDir),
    ...fieldDescriptions.issues,
    ...findUnusedParameterTypes(vocabulary, config.parameterTypes),
    ...findSupportOriginParameterTypes(compatParameterTypes),
    ...findUnknownSecretsKeys(rootDir, config),
    ...findUnusedFixtures(vocabulary, fixtureGraph),
    ...findFixturesTouchingApp(fixtureGraph),
    ...findFixturesReplacingBuiltins(Object.keys(config.fixtures)),
    ...findPostNavigationReads(rootDir, config.stateDir),
    ...findRepeatedScenarioPrefixes(rootDir, config.stateDir, features),
    ...findTypelessPackageJsons(rootDir, [...loadedConfigFile(rootDir), ...walkedFiles]),
  ];

  const summary = buildTendSummary(vocabulary, fieldDescriptions, scannedFeatureDirs);

  // Every finding names a file to open. A step finding names the step's
  // file. Fixtures, parameter types, and secrets are config entries.
  const configFile = resolveConfigFileName(rootDir);
  const fileFor = (issue: TendIssue): string | undefined => {
    if (issue.file !== undefined) return issue.file;
    if (issue.step !== undefined) {
      const entry = vocabulary.get(issue.step);
      return entry === undefined ? undefined : rootRelativeStepFile(rootDir, entry);
    }
    return CONFIG_ENTRY_CODES.has(issue.code) ? configFile : undefined;
  };
  const finish = (issue: TendIssue): TendFinding => {
    const file = fileFor(issue);
    return { ...issue, ...(file !== undefined ? { file } : {}), fix: issue.fix ?? tendCodeFix(issue.code) };
  };

  return { errors: errors.map(finish), notes: notes.map(finish), summary };
}
