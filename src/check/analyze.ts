import { existsSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { UnsupportedTagExpressionError } from "../compat/errors.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig, resolveConfigFileName } from "../config/load-config.js";
import { cjsTsMismatchExplanation, refusesEsmTs } from "../config/module-kind.js";
import { isPlaywrightInstalled } from "../context/load-playwright.js";
import { discoverSteps, type DiscoveryResult } from "../discover/discover-steps.js";
import {
  attachStepLines,
  findOutlinesThatDoNotRun,
  findScenarioShapeFindings,
  findSerialTagOnScenario,
  loadFeaturesFromDirs,
  type LoadFeaturesResult,
  type OutlineDoesNotRun,
  type ScenarioShapeFinding,
} from "../feature/load-features.js";
import { knownFixtureNames, validateFixtureDefinitions, validateStepFixtures } from "../fixture/validate-fixtures.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { stepNeeds } from "../fixture/step-needs.js";
import { ignoredStepOptions, STEP_OPTION_NAMES } from "../step/define-step.js";
import { registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { validateStepParts } from "../step/validate-parts.js";
import { hookDisplayTitle } from "../record/scenario-record.js";
import { checkBindings } from "./binding-check.js";
import { checkConfig } from "./config-check.js";
import {
  declaresDoneCallback,
  doneCallbackMessage,
  RUN_HOOK_ARG_COUNT,
  SCENARIO_HOOK_ARG_COUNT,
} from "./done-callback.js";
import { checkExploreDeclarations } from "./explore-check.js";
import { checkFeatures, type UndefinedStepLine } from "./feature-check.js";
import { missingTsSourceSentence } from "./missing-ts-source.js";
import { findPartCycles, findPartMutatesContradictions } from "./parts-check.js";
import { findPlaywrightMissing, playwrightImportMissing } from "./playwright-check.js";
import { checkCodeDo } from "./codes.js";
import { noStepFilesDo } from "./no-step-files-do.js";
import { importSuppressionDo } from "./suppressed-do.js";
import type { CheckFinding, CheckIssue, CheckReport } from "./types.js";
import {
  boundStepNames,
  findUnboundPatternedEntries,
  rootRelativeStepFile,
  unboundPatternedSuffix,
} from "./unbound-patterned.js";

function withUnboundSuffix(issues: readonly CheckIssue[], suffix: () => string): CheckIssue[] {
  if (!issues.some((issue) => issue.code === "undefined-step")) {
    return [...issues];
  }
  const text = suffix();
  return issues.map((issue) => (issue.code === "undefined-step" ? { ...issue, message: issue.message + text } : issue));
}

function scenarioShapeWarning(finding: ScenarioShapeFinding): CheckIssue {
  if (finding.code === "scenario-without-then") {
    return {
      code: finding.code,
      message:
        `Scenario "${finding.name}" has no Then step, so it passes whenever its steps run without an error, ` +
        "and no step checks an outcome.",
      file: finding.relativePath,
      line: finding.line,
    };
  }
  const columns = finding.columns.map((column) => `<${column}>`).join(", ");
  return {
    code: finding.code,
    message:
      `Scenario outline "${finding.name}" has ${finding.rows} Examples rows, and its name uses none of the ` +
      `columns (${columns}), so every row is reported under the same name.`,
    file: finding.relativePath,
    line: finding.line,
    ...(finding.columns[0] !== undefined
      ? { do: `Add a column to the name, such as: ${finding.name} <${finding.columns[0]}>` }
      : {}),
  };
}

function ignoredOptionWarning(stepName: string, key: string, file: string): CheckIssue {
  if (key === "rationale") {
    return {
      code: "step-option-ignored",
      message: `Step "${stepName}" passes rationale, which defineStep no longer reads, so its text is shown nowhere`,
      file,
      step: stepName,
      do: `Move the rationale text into a comment above defineStep in ${file}, then delete the rationale: line.`,
    };
  }
  return {
    code: "step-option-ignored",
    message: `Step "${stepName}" passes ${key}, which is not a defineStep option, so it has no effect`,
    file,
    step: stepName,
    do: `Delete ${key} from the defineStep call in ${file}, or rename it to an option defineStep reads: ${STEP_OPTION_NAMES.join(", ")}.`,
  };
}

function outlineDoesNotRunMessage(issue: OutlineDoesNotRun): string {
  if (issue.reason === "no-examples") {
    return (
      `Scenario outline "${issue.name}" has no Examples table, so the placeholder text runs as written. ` +
      "Add one Examples row for each boundary that must run."
    );
  }
  return (
    `Scenario "${issue.name}" has an Examples table with no rows, so the scenario is left out of the run. ` +
    "Add a row, or remove the table."
  );
}

// Responsibility: the one function `nuka check` runs — load the project the
// same way `nuka steps`/`nuka do` already do (loadConfig, discoverSteps),
// then run every check category and merge their issues into the single
// `{ errors, warnings }` report docs/spec.md's "CLI summary" describes.
//
// A project's config failing to load, or discovery finding a duplicate step
// name/pattern/`defineWorld`, is *not* one of this report's issues — it is
// the same fundamental failure `nuka steps`/`nuka do` already report via
// ConfigError/DuplicateStepError/DuplicateCompatStepError/
// DuplicateWorldDefinitionError, so it propagates unchanged and
// src/cli/check.ts handles it exactly like every other command does
// (stderr + exit 1, no report): both are cross-project authoring mistakes a
// migrating suite is not expected to be mid-fixing the way it is expected to
// have some glue files still broken.
//
// A broken step file's own import failure, by contrast, *is* one of this
// report's issues (a change from this module's
// earlier behavior, where it fell into the same fundamental-failure bucket
// as the paragraph above): `discoverSteps` is called with
// `{ tolerateImportFailures: true }` below, so one broken glue file no
// longer takes down the entire report the way a config load failure still
// does. The reason for the split: a migrating suite's *normal* state is
// "some glue files are still broken" (docs/spec.md's compat/migration
// story), so treating every broken file as a hard stop would make `nuka
// check` useless as a migration dashboard for exactly the projects that need
// it most — nothing about *this* file's own report is unreliable just
// because some other file failed to import. A malformed `.feature` file
// keeps its own pre-existing category (`feature-parse-error`) for the same
// reason: one broken file must not stop every other feature's issues from
// being reported.

/** The report a `nuka check` with no target gives: every feature under
 * featuresDir and additionalFeatureDirs, and every configured oath. */
export async function analyzeProject(rootDir: string): Promise<CheckReport> {
  // additionalFeatureDirs joins featuresDir here: a no-target `nuka check`
  // is one of the two commands whose default scan includes it (`nuka tend`
  // is the other), while `nuka run`'s default scan does not. A config
  // mistake in additionalFeatureDirs itself is config-check.ts's own
  // `additional-feature-dir-missing`, not repeated here;
  // `missingAdditionalDirs` is intentionally unread.
  const { report } = await analyze(
    rootDir,
    (config) => loadFeaturesFromDirs(rootDir, config.featuresDir, config.additionalFeatureDirs, config.oaths),
    false,
  );
  return report;
}

/** One feature file as `nuka run` selected it: its document, and only the
 * pickles its targets select. */
export interface SelectedFeatureForCheck {
  readonly relativePath: string;
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

/**
 * The report for the features a `nuka run` or `nuka check` target
 * selects, with the feature-level checks run over exactly those pickles
 * instead of a walk of featuresDir. Every project-wide finding (config,
 * bindings, every step's own declaration, fixture definitions, step files
 * that fail to import) is the same as `analyzeProject`'s, because those
 * break a run no matter which scenario it selects. A `:line` target
 * narrows only the scenario-level findings: a run of one scenario is not
 * refused over a sibling scenario it does not execute.
 *
 * `parseErrors` is empty for `nuka run`, which refuses a target that does
 * not parse. `nuka check` passes the selected files that failed to parse,
 * so one broken file is a finding beside the others' findings, the same
 * as in a walk of featuresDir.
 */
export async function analyzeRunSelection(
  rootDir: string,
  selected: readonly SelectedFeatureForCheck[],
  parseErrors: LoadFeaturesResult["parseErrors"] = [],
): Promise<CheckReport> {
  const { report } = await analyze(rootDir, runSelectionFeatures(selected, parseErrors), true);
  return report;
}

function runSelectionFeatures(
  selected: readonly SelectedFeatureForCheck[],
  parseErrors: LoadFeaturesResult["parseErrors"],
): () => LoadFeaturesResult {
  return () => ({
    features: selected.map((feature) => ({
      relativePath: feature.relativePath,
      pickles: attachStepLines(feature.pickles, feature.gherkinDocument),
    })),
    parseErrors,
    serialTagOnScenario: selected.flatMap((feature) =>
      findSerialTagOnScenario(feature.gherkinDocument, feature.relativePath),
    ),
    outlinesThatDoNotRun: selected.flatMap((feature) =>
      findOutlinesThatDoNotRun(feature.gherkinDocument, feature.relativePath),
    ),
    scenarioShapeFindings: selected.flatMap((feature) =>
      findScenarioShapeFindings(feature.gherkinDocument, feature.relativePath),
    ),
  });
}

/** A run-selection report, and the discovery it was built from. */
export interface RunSelectionAnalysis {
  readonly report: CheckReport;
  readonly discovery: DiscoveryResult;
  /** The lines the report calls `undefined-step`, empty while that finding
   * is held back because a step file did not import. */
  readonly undefinedSteps: readonly UndefinedStepLine[];
}

/**
 * `analyzeRunSelection` for `nuka run`, which executes the same step
 * modules the check imported instead of importing every step file a second
 * time: a step file's module-scope code runs once per run, and the
 * import cost is paid once. The discovery is tolerant, so it holds every
 * file that imported; `nuka run` executes only when the report has no
 * error, and a file that failed to import is always an error
 * (`step-file-import-failed`), so what it executes is what a strict
 * discovery would have returned.
 */
export async function analyzeRunSelectionKeepingSteps(
  rootDir: string,
  selected: readonly SelectedFeatureForCheck[],
): Promise<RunSelectionAnalysis> {
  return analyze(rootDir, runSelectionFeatures(selected, []), true);
}

type Config = Awaited<ReturnType<typeof loadConfig>>;

async function analyze(
  rootDir: string,
  loadFeatures: (config: Config) => LoadFeaturesResult,
  selection: boolean,
): Promise<RunSelectionAnalysis> {
  const config = await loadConfig(rootDir);
  // Tolerant mode: a broken step file
  // becomes a report entry (`importFailures`, handled below) instead of
  // rejecting this whole call the way `run --no-check`/`do`/`steps`/`init`
  // still do via their own plain `discoverSteps(rootDir, config.featuresDir)`
  // calls.
  const discovery = await discoverSteps(rootDir, config.featuresDir, { tolerateImportFailures: true });
  return { ...(await reportFor(rootDir, config, discovery, loadFeatures, selection)), discovery };
}

async function reportFor(
  rootDir: string,
  config: Config,
  discovery: DiscoveryResult,
  loadFeatures: (config: Config) => LoadFeaturesResult,
  selection: boolean,
): Promise<{ report: CheckReport; undefinedSteps: readonly UndefinedStepLine[] }> {
  const {
    vocabulary,
    models,
    relations,
    compatParameterTypes,
    compatHooks,
    compatRunHooks,
    importFailures,
    unsupportedExtensionFiles,
    walkedFiles,
  } = discovery;

  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  // Node's own error message is the base of every entry below, unmodified:
  // it already names the missing export, subpath, or package, so re-parsing
  // it here would mean depending on Node's own wording while losing
  // information rather than adding any. The one exception is a Playwright
  // package the step file imports and the project lacks: that is
  // `playwright-missing` (src/check/playwright-check.ts), because Node's
  // "Did you mean" hint there points at the wrong fix. See this file's own header for why
  // a broken glue file is a report entry here rather than the fundamental
  // failure it still is for `run`/`do`/`steps`/`init`.
  //
  // `missingTsSourceSentence` appends the `.ts` file a missing `.js` import
  // stands for, and `cjsTsMismatchExplanation` the one sentence that names a
  // CommonJS/.ts mismatch, each only when that is the cause
  // (src/check/missing-ts-source.ts, src/config/module-kind.ts); everywhere
  // else they append nothing, so Node's message passes through exactly as
  // it came.
  const cjsProject = refusesEsmTs(rootDir);
  const importFindings: CheckIssue[] = [];
  for (const failure of importFailures) {
    const playwright = playwrightImportMissing(failure);
    if (playwright !== undefined) {
      importFindings.push(playwright);
      continue;
    }
    const message =
      failure.message +
      missingTsSourceSentence(failure.message, rootDir, existsSync) +
      cjsTsMismatchExplanation(cjsProject, failure.filePath);
    importFindings.push({
      code: "step-file-import-failed",
      message,
      file: failure.filePath,
      line: failure.line,
    });
  }
  errors.push(...importFindings);

  // Both findings below are
  // decidable from the walk alone (an extension check, a length check),
  // never a guess about a file's contents — and both are things a run needs
  // known beforehand, the same standard that sorts a finding into `check`
  // rather than `tend`. Errors, not warnings: a `.cjs`
  // file is nukadoko's one already-documented go/no-go (docs/migration.md
  // "CommonJS glue"), the same certainty `step-file-import-failed` above
  // already gets error severity for, and a featuresDir with nothing loadable
  // in it guarantees every scenario fails as `undefined-step` — strictly
  // worse than the single broken file that finding already covers.
  for (const filePath of unsupportedExtensionFiles) {
    errors.push({
      code: "step-file-unsupported-extension",
      message: `discovery found "${filePath}", which is CommonJS (${path.extname(filePath)} extension); nukadoko is ESM-only and never imports it, so any step it defines never reaches the vocabulary`,
      file: filePath,
    });
  }

  // Skipped when featuresDir itself doesn't exist on disk: config-check.ts's
  // own `features-dir-missing` already names that exact fact, and repeating
  // it here under a second code would be the same root cause reported
  // twice, not two distinct pieces of information for a reader to act on.
  const featuresRoot = path.join(rootDir, config.featuresDir);
  const noStepFiles = walkedFiles.length === 0 && existsSync(featuresRoot) ? errors.length : undefined;
  if (noStepFiles !== undefined) {
    errors.push({
      code: "no-step-files-found",
      message: `no .ts/.mts/.js/.mjs step file was found while scanning "${config.featuresDir}" (resolved to ${featuresRoot}); no step can ever be registered`,
      file: config.featuresDir,
    });
  }

  // The same tag-expression validation `nuka run` runs before executing any
  // pickle (src/cli/run.ts, near its own `validateTagExpression` call) —
  // reused here via the one shared function rather than copied, but run
  // every hook through it instead of stopping at the first violation:
  // a report lists every finding, where
  // `run`'s own try/catch existing early-exit behavior is untouched. No
  // `file`: a hook isn't attributed to the file that registered it
  // (src/discover/discover-steps.ts's own header explains why). Discovery
  // does not record which file registered a hook, so this finding has no
  // file to name.
  for (const hook of compatHooks) {
    if (hook.tags === undefined) {
      continue;
    }
    try {
      validateTagExpression(hook.tags);
    } catch (error) {
      if (!(error instanceof UnsupportedTagExpressionError)) {
        throw error;
      }
      errors.push({ code: "unsupported-hook-tag-expression", message: error.message });
    }
  }

  // The same arity the executor refuses before calling the function
  // (src/run/run-scenario.ts for a scenario hook, src/cli/run.ts for a
  // run-scope hook). Discovery already holds every fn, so the limit does
  // not depend on which scenario runs. The title is the same string the
  // executor puts in the failure: a hook `name` replaces the keyword, and
  // a missing name keeps it. No `file`: a hook is not attributed to the
  // file that registered it, same as the tag-expression finding above.
  for (const hook of compatHooks) {
    if (!declaresDoneCallback(hook.fn.length, SCENARIO_HOOK_ARG_COUNT)) {
      continue;
    }
    const keyword = hook.type === "before" ? "Before" : hook.type === "after" ? "After" : "AfterStep";
    errors.push({
      code: "done-callback-arity",
      message: doneCallbackMessage("Hook", hookDisplayTitle(keyword, hook.name)),
    });
  }
  for (const hook of compatRunHooks) {
    if (!declaresDoneCallback(hook.fn.length, RUN_HOOK_ARG_COUNT)) {
      continue;
    }
    const keyword = hook.type === "beforeAll" ? "BeforeAll" : "AfterAll";
    errors.push({
      code: "done-callback-arity",
      message: doneCallbackMessage("Hook", hookDisplayTitle(keyword, hook.name)),
    });
  }

  const configResult = await checkConfig(rootDir, config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  const bindingResult = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  errors.push(...bindingResult.issues);
  warnings.push(...bindingResult.warnings);

  // `from`'s own structural validation (src/step/validate-from.ts's
  // `validateStepFrom`) — docs/spec.md "Chaining steps"
  // promises "`nuka check` reports it" for the same findings `run`/`do`
  // already refuse to execute over (src/cli/run.ts, src/cli/do.ts); this is
  // that promise's other half, which was missing until now.
  // `isRegisteredStep` is built once, from the whole vocabulary, and
  // `validateStepFrom` is called once per typed step — not once per pickle
  // that happens to use it (unlike `checkFromOrder` below) — because a
  // structural finding here is a property of the step's own declaration: it
  // holds or fails identically everywhere the step is used, so reporting it
  // once per occurrence would just be the same message repeated per feature.
  const isRegisteredStep = registeredStepPredicate(
    [...vocabulary.values()].flatMap((entry) => (entry.kind === "typed" ? [entry.step] : [])),
  );
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat steps have no `from` at all (no typed contract).
    }
    for (const issue of validateStepFrom(entry.name, entry.step, isRegisteredStep)) {
      errors.push({
        code: "from-structural-violation",
        message: issue.message,
        // rootDir-relative, matching every other CheckIssue.file this report
        // produces (src/discover/discover-steps.ts's own header, on
        // CompatParameterTypeEntry.filePath) — unlike that field,
        // TypedVocabularyEntry.filePath is stored absolute, so it needs the
        // same relativizing importFailures/compatParameterTypes already get.
        file: path.relative(rootDir, entry.filePath),
        step: issue.step,
      });
    }
  }

  // A warning, not an error: an ignored key changes nothing at run time.
  // It is still a fact, not a guess, because defineStep saw the object.
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue;
    }
    const file = path.relative(rootDir, entry.filePath);
    for (const key of ignoredStepOptions(entry.step)) {
      warnings.push(ignoredOptionWarning(entry.name, key, file));
    }
  }

  // `parts`' own structural validation (src/step/validate-parts.ts's
  // `validateStepParts`) — docs/spec.md "Parts" promises `nuka check` reads
  // the declaration before anything runs; this is that promise's static
  // half, the same "not-a-Step or never-registered" judgment
  // `from-structural-violation` just made above, reusing the same
  // `isRegisteredStep` predicate (one vocabulary, one registration fact,
  // never rebuilt per check).
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat steps have no `parts` at all (no typed contract).
    }
    for (const issue of validateStepParts(entry.name, entry.step, isRegisteredStep)) {
      errors.push({
        code: "part-structural-violation",
        message: issue.message,
        file: path.relative(rootDir, entry.filePath),
        step: issue.step,
      });
    }
  }

  // The two `parts` findings that are facts about the whole graph, not
  // about one step's own declaration in isolation (src/check/parts-check.ts
  // — see that module's own header for why both skip an edge to a part
  // `part-structural-violation` above already flagged, rather than
  // reporting the same broken edge a second time under a placeholder name).
  for (const issue of findPartCycles(vocabulary)) {
    errors.push({ code: issue.code, message: issue.message, step: issue.step });
  }
  for (const issue of findPartMutatesContradictions(vocabulary)) {
    errors.push({
      code: issue.code,
      message: issue.message,
      file: path.relative(rootDir, issue.filePath),
      step: issue.step,
    });
  }

  // A model or a relation names steps by basename. That name is either a
  // file discovery registered, or it is not, and the step either needs a
  // browser or it does not. Both are known before any step runs, so they
  // belong here rather than in the runner. `checkExploreDeclarations` does
  // not call the model or the relation.
  const fixtureGraph = buildFixtureGraph(config);
  for (const issue of checkExploreDeclarations({
    vocabulary,
    models,
    relations,
    needsBrowser: (step) => stepNeeds(step, fixtureGraph).needsBrowser,
  })) {
    errors.push({
      ...issue,
      file: issue.file === undefined ? undefined : path.relative(rootDir, issue.file),
    });
  }

  // The fixture-bag counterpart to the `from` structural check just above:
  // this is the same validation `nuka check` and `nuka run` share
  // (docs/spec.md "Context API"), so a
  // malformed step is judged identically whether it's caught here or at run
  // time. An unknown fixture name, or a `run()` whose first
  // argument isn't a plain object-destructuring pattern, is reported once per
  // typed step (src/fixture/validate-fixtures.ts's own `validateStepFixtures`),
  // same "once per declaration, not once per occurrence" reasoning as above.
  // `knownNames` widens the closed builtin-only set this check first shipped
  // against to builtins ∪ `config.fixtures` — a step
  // naming a real user fixture is no longer reported as unknown.
  const knownNames = knownFixtureNames(config);
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat steps have no fixture bag at all (no typed `run`).
    }
    for (const issue of validateStepFixtures(entry.name, entry.step, knownNames)) {
      errors.push({
        code: "fixture-structural-violation",
        message: issue.message,
        file: path.relative(rootDir, entry.filePath),
        step: issue.step,
      });
    }
  }

  // The `config.fixtures` *definitions* themselves — a fixture destructuring an unknown name (same judgment as
  // above, applied to a fixture's own body), a dependency cycle, a
  // `"process"`-scope fixture depending on a `"scenario"`-scope one, and `page`
  // overridden by a fixture that owns neither `page` nor `context`
  // (src/fixture/graph.ts does the actual graph-shape work; this file only
  // turns its findings into a `CheckIssue`, the same shape every other
  // category here already produces). `file` names the config file itself —
  // that is where every `config.fixtures` entry actually lives, the same
  // "file" field src/check/config-check.ts's own config-level findings
  // already use — resolved via resolveConfigFileName rather than
  // hard-coded, since a CommonJS project reads its config from
  // nukadoko.config.mts, not nukadoko.config.ts. The fixture's own name is
  // already part of each issue's `message`
  // (src/fixture/validate-fixtures.ts), so `step` is left unset rather than
  // repurposed for a subject it was never meant to carry.
  const configFileName = resolveConfigFileName(rootDir);
  for (const issue of validateFixtureDefinitions(config)) {
    errors.push({ code: issue.code, message: issue.message, file: configFileName });
  }

  const { features, parseErrors, serialTagOnScenario, outlinesThatDoNotRun, scenarioShapeFindings } =
    loadFeatures(config);
  for (const parseError of parseErrors) {
    errors.push({
      code: "feature-parse-error",
      message: parseError.message,
      file: parseError.relativePath,
      line: parseError.line,
    });
  }
  // `@nukadoko:serial` read anywhere but a `Feature:` line does nothing at all
  // (`nuka run --concurrency <n>` never looks there) — reported as an
  // error, the same certainty `unterminated-capture`/`unnamed-capture` get,
  // because whether the tag has an effect here is a fact, not a guess, and
  // a project that trusts it into forcing mutual exclusion between files
  // gets silent data-race exposure instead.
  for (const issue of serialTagOnScenario) {
    errors.push({
      code: "serial-tag-on-scenario",
      message:
        `@nukadoko:serial on scenario "${issue.name}" has no effect: nuka run --concurrency reads ` +
        "@nukadoko:serial only from " +
        "the Feature line. Move the tag there.",
      file: issue.relativePath,
      line: issue.line,
    });
  }
  for (const issue of outlinesThatDoNotRun) {
    errors.push({
      code: "outline-does-not-run",
      message: outlineDoesNotRunMessage(issue),
      file: issue.relativePath,
      line: issue.line,
    });
  }
  // Warnings, not errors: a scenario with no Then can be a deliberate smoke
  // test, and rows that share a name can be what the author wants to read.
  for (const finding of scenarioShapeFindings) {
    warnings.push(scenarioShapeWarning(finding));
  }
  const featureResult = checkFeatures(
    features,
    vocabulary,
    bindingResult.patterns,
    [...config.parameterTypes, ...compatParameterTypes],
    bindingResult.standIns,
  );
  warnings.push(...featureResult.warnings);
  if (noStepFiles !== undefined) {
    const scaffoldDo = noStepFilesDo(
      featureResult.undefinedSteps.map((line) => line.file),
      config.featuresDir,
    );
    if (scaffoldDo !== undefined) errors[noStepFiles] = { ...errors[noStepFiles]!, do: scaffoldDo };
  }
  // A renamed sentence or pattern leaves a line undefined and a step unbound
  // in the same analysis; naming the unbound step beside the line keeps the
  // scaffold hint from being the only lead. Bound is judged on every feature
  // the project scans, even for a target (src/check/unbound-patterned.ts
  // says why), so only an undefined line pays for the wider read.
  const featureErrors = withUnboundSuffix(featureResult.errors, () => {
    // A target outside every scanned directory is not counted, the same as
    // for tend: the suffix's own wording says which lines were read.
    const bound = selection
      ? boundStepNames(
          loadFeaturesFromDirs(rootDir, config.featuresDir, config.additionalFeatureDirs, config.oaths).features,
          bindingResult.patterns,
        )
      : new Set(featureResult.boundSteps.map((line) => line.stepName));
    return unboundPatternedSuffix(findUnboundPatternedEntries(vocabulary, bound), rootDir);
  });
  errors.push(...findPlaywrightMissing(featureResult.boundSteps, vocabulary, fixtureGraph, isPlaywrightInstalled));

  // A broken glue file's own missing steps otherwise resurface here as a
  // flood of `undefined-step` errors (empirically, a
  // 1-broken-file-to-20-undefined-step ratio) — noise that
  // buries the one real cause (the import failure already reported above)
  // and misleadingly reads as "write this step", when the step may well
  // already exist in the file that failed to import. Suppressed only when
  // there is at least one import failure to blame it on, and only
  // `undefined-step` itself: every other feature-check issue is a property
  // of a step that *did* match something, so it isn't contaminated by a
  // vocabulary that's missing entries.
  if (importFailures.length > 0) {
    const suppressedCount = featureErrors.filter((issue) => issue.code === "undefined-step").length;
    for (const issue of featureErrors) {
      if (issue.code !== "undefined-step") {
        errors.push(issue);
      }
    }
    if (suppressedCount > 0) {
      warnings.push({
        code: "undefined-step-check-suppressed",
        message: `Suppressed ${suppressedCount} undefined-step ${suppressedCount === 1 ? "issue" : "issues"} because ${importFailures.length} step ${importFailures.length === 1 ? "file" : "files"} could not be read. undefined-step judgment is on hold until the unreadable glue is fixed`,
        file: importFailures[0]!.filePath,
        do: importSuppressionDo(importFindings),
      });
    }
  } else {
    errors.push(...featureErrors);
  }

  // A step-scoped finding is raised with the step's name only; the file
  // that defines the step is what an agent opens to fix it.
  const finish = (issue: CheckIssue): CheckFinding => {
    const entry = issue.file === undefined && issue.step !== undefined ? vocabulary.get(issue.step) : undefined;
    return {
      ...issue,
      ...(entry !== undefined ? { file: rootRelativeStepFile(rootDir, entry) } : {}),
      do: issue.do ?? checkCodeDo(issue.code),
    };
  };

  return {
    report: { errors: errors.map(finish), warnings: warnings.map(finish) },
    undefinedSteps: importFailures.length > 0 ? [] : featureResult.undefinedSteps,
  };
}
