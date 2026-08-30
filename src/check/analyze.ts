import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { UnsupportedTagExpressionError } from "../compat/errors.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig, resolveConfigFileName } from "../config/load-config.js";
import { cjsTsMismatchExplanation, isCommonJsProject } from "../config/module-kind.js";
import { discoverSteps } from "../discover/discover-steps.js";
import {
  attachStepLines,
  findSerialTagOnScenario,
  loadFeaturesFromDirs,
  parseFeatureSource,
  type LoadFeaturesResult,
} from "../feature/load-features.js";
import { knownFixtureNames, validateFixtureDefinitions, validateStepFixtures } from "../step/validate-fixtures.js";
import { registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { validateStepParts } from "../step/validate-parts.js";
import { checkBindings } from "./binding-check.js";
import { checkConfig } from "./config-check.js";
import { checkFeatures } from "./feature-check.js";
import { findPartCycles, findPartMutatesContradictions } from "./parts-check.js";
import type { CheckIssue, CheckReport } from "./types.js";

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
//
// `featureArg`, when given, *replaces*
// which feature(s) get checked — the `featuresDir` (+`additionalFeatureDirs`)
// walk above is skipped entirely in favor of that
// one file (not added to it: an existing error under `featuresDir` would
// otherwise bury the very feature this argument exists to single out).
// `discoverSteps` above is untouched by this parameter (config/binding
// checks and the vocabulary they check features against always come from
// `featuresDir`) — only the `loadFeaturesFromDirs` call
// below is conditional. A `featureArg` that doesn't exist or can't be read
// is a usage mistake, not a project finding: it
// throws `CheckFeatureNotFoundError` (message pre-formatted "nuka check: …",
// same tone as `nuka accept`'s own hand-written stderr messages) rather than
// becoming a `feature-parse-error` report entry, and src/cli/check.ts's
// existing catch-all (already used for ConfigError/DuplicateStepError)
// turns it into stderr + exit 1 unchanged. A file that *does* exist but
// fails to parse, by contrast, stays a `feature-parse-error` report entry —
// the same category a broken file under `featuresDir` gets — since that is
// a real property of the feature file itself, not a bad argument.

export class CheckFeatureNotFoundError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`nuka check: feature file not found: ${relativePath}`);
    this.name = "CheckFeatureNotFoundError";
    this.relativePath = relativePath;
  }
}

// A `:line` suffix that `nuka run`'s own `parseFeatureTarget`
// (src/run/select-pickles.ts) would strip and act on is, to `readFileSync`
// below, just more path text — so a target like `probe.feature:3` fails
// the same ENOENT a genuinely missing file would, and used to be reported
// with the identical "feature file not found" wording either way. That
// wording is wrong for this case specifically: the file is right there.
// Matches `parseFeatureTarget`'s own pattern (kept as a separate literal
// here rather than an import — see this module's own file for why: no
// legitimate `.feature` path ends in `:<digits>` on its own).
const LINE_SUFFIX_PATTERN = /^(.+):(\d+)$/;

export class CheckLineNotSupportedError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string, line: string) {
    super(
      `nuka check: ${relativePath}:${line}: :line is not supported; check analyzes the whole file, not one scenario. ` +
        `Run: nuka check ${relativePath}`,
    );
    this.name = "CheckLineNotSupportedError";
    this.relativePath = relativePath;
  }
}

// Path resolution matches `nuka run`/`nuka accept` (relative to `rootDir`,
// absolute paths accepted as-is). No `:line`
// support: check is a static analysis over a whole
// file, not one scenario.
function loadSingleFeature(rootDir: string, featureArg: string): LoadFeaturesResult {
  const relativePath = path.relative(rootDir, path.resolve(rootDir, featureArg));
  const absolutePath = path.join(rootDir, relativePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    // Genuinely missing and ":line" given but ignored (this module's own
    // header) read identically here (both fail the same `readFileSync`),
    // so they are told apart by asking one more question before deciding
    // which error to throw: does the path with the trailing ":<digits>"
    // stripped off exist? Only the ":line" case can answer yes, since
    // stripping nothing off a genuinely missing path still names a
    // genuinely missing path.
    const lineMatch = LINE_SUFFIX_PATTERN.exec(relativePath);
    if (lineMatch) {
      const [, basePath, line] = lineMatch;
      if (existsSync(path.join(rootDir, basePath!))) {
        throw new CheckLineNotSupportedError(basePath!, line!);
      }
    }
    throw new CheckFeatureNotFoundError(relativePath);
  }

  try {
    // `attachStepLines`/`findSerialTagOnScenario` mirror src/feature/
    // load-features.ts's own `loadFeaturesFromDirs` — the same two
    // "read the GherkinDocument before it's dropped" steps, done here too
    // since this function is the featureArg path's own equivalent of that
    // walk, not a call through it.
    const { gherkinDocument, pickles } = parseFeatureSource(source, relativePath);
    return {
      features: [{ relativePath, pickles: attachStepLines(pickles, gherkinDocument) }],
      parseErrors: [],
      serialTagOnScenario: findSerialTagOnScenario(gherkinDocument, relativePath),
    };
  } catch (error) {
    return {
      features: [],
      parseErrors: [
        { relativePath, message: error instanceof Error ? error.message : String(error) },
      ],
      serialTagOnScenario: [],
    };
  }
}

// esbuild's own transform-error format, measured directly rather than
// guessed:
// "Transform failed with N error(s):\n<path>:<line>:<col>: ERROR: <msg>",
// one line per error. Matched against the *start* of a line (`^` + `m`) so
// this never fires on a colon that happens to sit inside the error text
// itself. Node's own ESM-loader errors (a missing named export, `require`
// called from an ES module) carry no such prefix at all, so this simply
// finds nothing on those and `line` is left unset — same as before this
// task (CheckIssue.line already optional, src/check/types.ts).
const IMPORT_FAILURE_LOCATION = /^(.+):(\d+):(\d+): ERROR: /m;

// A module that fails to import can drag another file's failure into its
// own message: Node's ESM loader caches a module that failed to load and
// rethrows the identical error object to every later importer (the same
// behavior tests/check-import-failure-grouping.test.ts exercises for a
// location-less message). When that happens here, the location named in
// the message is the file that actually failed to transform, not the file
// this `importFailures` entry is attributed to — attaching it would point
// a reader at the wrong file, so this returns `undefined` instead.
// `path.resolve` against `rootDir` on both sides absorbs the absolute/
// relative difference between them: the
// message always carries the absolute path esbuild was given, while
// `issueFile` is rootDir-relative (discover-steps.ts's own
// `importFailures[].filePath`).
function extractImportFailureLine(message: string, rootDir: string, issueFile: string): number | undefined {
  const match = IMPORT_FAILURE_LOCATION.exec(message);
  if (match === null) {
    return undefined;
  }
  const [, rawPath, rawLine] = match;
  if (rawPath === undefined || rawLine === undefined) {
    return undefined;
  }
  if (path.resolve(rootDir, rawPath) !== path.resolve(rootDir, issueFile)) {
    return undefined;
  }
  return Number(rawLine);
}

export async function analyzeProject(rootDir: string, featureArg?: string): Promise<CheckReport> {
  const config = await loadConfig(rootDir);
  // Tolerant mode — a broken step file
  // becomes a report entry (`importFailures`, handled below) instead of
  // rejecting this whole call the way `run`/`do`/`steps`/`init` still do via
  // their own plain `discoverSteps(rootDir, config.featuresDir)` calls.
  const {
    vocabulary,
    compatParameterTypes,
    compatHooks,
    importFailures,
    unsupportedExtensionFiles,
    walkedFiles,
  } = await discoverSteps(rootDir, config.featuresDir, { tolerateImportFailures: true });

  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  // Node's own error message is the base of every entry below, unmodified:
  // it already names the missing export, subpath, or package, so re-parsing
  // it here would mean depending on Node's own wording while losing
  // information rather than adding any. See this file's own header for why
  // a broken glue file is a report entry here rather than the fundamental
  // failure it still is for `run`/`do`/`steps`/`init`.
  //
  // `cjsTsMismatchExplanation` appends the one sentence that names a
  // CommonJS/.ts mismatch when that's the real cause (its own doc comment,
  // src/config/module-kind.ts); everywhere else it appends nothing, so
  // Node's message passes through exactly as it came.
  const cjsProject = isCommonJsProject(rootDir);
  for (const failure of importFailures) {
    const message = `${failure.message}${cjsTsMismatchExplanation(cjsProject, failure.filePath)}`;
    errors.push({
      code: "step-file-import-failed",
      message,
      file: failure.filePath,
      // Extracted from Node's own message above, never re-derived some
      // other way — the location, when present, is always in the part
      // passed through verbatim.
      line: extractImportFailureLine(failure.message, rootDir, failure.filePath),
    });
  }

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
      message: `discovery found "${filePath}", which is CommonJS (.cjs extension); nukadoko is ESM-only and never imports it, so any step it defines never reaches the vocabulary`,
      file: filePath,
    });
  }

  // Skipped when featuresDir itself doesn't exist on disk: config-check.ts's
  // own `features-dir-missing` already names that exact fact, and repeating
  // it here under a second code would be the same root cause reported
  // twice, not two distinct pieces of information for a reader to act on.
  const featuresRoot = path.join(rootDir, config.featuresDir);
  if (walkedFiles.length === 0 && existsSync(featuresRoot)) {
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
  // (src/discover/discover-steps.ts's own header explains why), and adding
  // that attribution is out of this task's scope.
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

  // The fixture-bag counterpart to the `from` structural check just above:
  // this is the same validation `nuka check` and `nuka run` share
  // (docs/spec.md "Context API"), so a
  // malformed step is judged identically whether it's caught here or at run
  // time. An unknown fixture name, or a `run()` whose first
  // argument isn't a plain object-destructuring pattern, is reported once per
  // typed step (src/step/validate-fixtures.ts's own `validateStepFixtures`),
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
  // (src/step/validate-fixtures.ts), so `step` is left unset rather than
  // repurposed for a subject it was never meant to carry.
  const configFileName = resolveConfigFileName(rootDir);
  for (const issue of validateFixtureDefinitions(config)) {
    errors.push({ code: issue.code, message: issue.message, file: configFileName });
  }

  const { features, parseErrors, serialTagOnScenario } =
    featureArg === undefined
      ? // additionalFeatureDirs joins featuresDir here too: a no-argument
        // `nuka check` is one of the two commands whose default scan
        // includes it (`nuka tend` is the other), while `nuka run`'s
        // default scan does not — a config mistake in additionalFeatureDirs
        // itself is config-check.ts's own `additional-feature-dir-missing`,
        // not repeated here; `missingAdditionalDirs` is intentionally
        // unread.
        loadFeaturesFromDirs(rootDir, config.featuresDir, config.additionalFeatureDirs)
      : loadSingleFeature(rootDir, featureArg);
  for (const parseError of parseErrors) {
    errors.push({
      code: "feature-parse-error",
      message: parseError.message,
      file: parseError.relativePath,
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
  const featureResult = checkFeatures(features, vocabulary, bindingResult.patterns, config.parameterTypes);
  warnings.push(...featureResult.warnings);

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
    const suppressedCount = featureResult.errors.filter((issue) => issue.code === "undefined-step").length;
    for (const issue of featureResult.errors) {
      if (issue.code !== "undefined-step") {
        errors.push(issue);
      }
    }
    if (suppressedCount > 0) {
      warnings.push({
        code: "undefined-step-check-suppressed",
        message: `Suppressed ${suppressedCount} undefined-step ${suppressedCount === 1 ? "issue" : "issues"} because ${importFailures.length} step ${importFailures.length === 1 ? "file" : "files"} could not be read. undefined-step judgment is on hold until the unreadable glue is fixed`,
      });
    }
  } else {
    errors.push(...featureResult.errors);
  }

  return { errors, warnings };
}
