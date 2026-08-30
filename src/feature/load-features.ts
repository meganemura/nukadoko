import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from "@cucumber/gherkin";
import {
  IdGenerator,
  type GherkinDocument,
  type Pickle,
  type PickleStep,
  type Scenario,
  type Step,
} from "@cucumber/messages";

// Responsibility: walk `featuresDir` plus each `additionalFeatureDirs` entry
// for `**/*.feature` files and turn each into pickles via @cucumber/gherkin
// — the official parser owns Background merging, Scenario Outline
// expansion, and table/docstring attachment (docs/spec.md "nukadoko
// deliberately owns as little as possible"). This module does not interpret
// a pickle's steps at all (matching them against the vocabulary is
// src/check/feature-check.ts's job) — it only turns `.feature` text into
// the pickles @cucumber/gherkin produces. A malformed feature file is
// collected as a per-file parse error rather than thrown, so one broken
// file doesn't stop `nuka check` from reporting every other feature's
// issues too (mirrors src/discover/discover-steps.ts's own tolerance for a
// missing featuresDir: an empty/partial answer beats a crash).
//
// `loadFeaturesFromDirs` de-duplicates by absolute path, so a file
// reachable from more than one of the walked directories (e.g. one nested
// inside another) is never parsed or counted twice. `featuresDir` is
// fail-open on a missing directory — config-check.ts's
// `features-dir-missing` already reports that case on its own, with its own
// message. An `additionalFeatureDirs` entry that does not exist, by
// contrast, is reported back via `missingAdditionalDirs` rather than
// silently treated as empty — it was named specifically to widen what gets
// scanned, so a typo in it is a config mistake, not a valid "nothing here"
// answer.
//
// `parseFeatureSource` is exported so `nuka run` (src/run/select-pickles.ts)
// can parse the one feature file it was pointed at without walking a whole
// directory — the same gherkin invocation, not a second copy of it; that
// module's own errors (missing file, `:line` matching nothing) are its
// business, not this one's.
//
// `parseFeatureSource` used to
// parse, then keep only `compile()`'s pickles and throw away `parser.parse`'s
// own `GherkinDocument` — the exact document a Before/After hook's
// `HookParameter.gherkinDocument` needs (src/compat/hooks.ts). Returning it
// alongside the pickles, rather than reconstructing or half-populating one
// later, is what keeps a hook's `gherkinDocument` from becoming its own new
// "silently read something undefined/partial" gap.
//
// `buildAstNodeLineMap`/`attachStepLines` exist because a pickle step never
// carries its own line — `@cucumber/messages`'s `PickleStep` has only
// `astNodeIds`, ids pointing back into the `GherkinDocument` a pickle was
// compiled from. `FeatureFile.pickles` resolves that lookup once, here,
// before the `GherkinDocument` itself is dropped, so a check finding about
// one step in a multi-step scenario can point at that step's own line
// instead of falling back to the whole scenario's line.

export interface FeatureFile {
  readonly relativePath: string;
  readonly pickles: readonly FeaturePickle[];
}

export interface FeatureParseError {
  readonly relativePath: string;
  readonly message: string;
}

/** One `@nukadoko:serial` tag found on a `Scenario:`/`Scenario Outline:` line, where
 * it has no effect at all (`nuka run --concurrency <n>` reads `@nukadoko:serial`
 * only off a `Feature:` line — docs/spec.md "Scenarios (the scripted
 * path)"; every scenario in one file already shares one worker, so a
 * Scenario-level copy of the tag can never mean anything different from
 * having no tag there). `nuka check`'s own `serial-tag-on-scenario` finding
 * is built straight from this shape (src/check/analyze.ts). */
export interface SerialTagOnScenario {
  readonly relativePath: string;
  readonly line: number;
  readonly name: string;
}

export interface LoadFeaturesResult {
  readonly features: readonly FeatureFile[];
  readonly parseErrors: readonly FeatureParseError[];
  readonly serialTagOnScenario: readonly SerialTagOnScenario[];
}

/** Exported for src/run/select-pickles.ts's own directory-target walk —
 * reused rather than re-implemented so
 * there is exactly one function that knows how to find every `.feature`
 * file under a directory. That caller re-sorts what this returns by
 * rootDir-relative path in plain byte order of its own (see that file's own
 * header for why): the tree-order sort this function applies below is
 * `nuka check`/`nuka tend`'s own convention, not what a run's own
 * determinism needs. */
export function walkFeatureFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // featuresDir (or a subdirectory) not existing is config-check.ts's
    // concern (config coherence), not this function's — an empty feature
    // list is a valid, if unhelpful, answer.
    return [];
  }

  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFeatureFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".feature")) {
      files.push(fullPath);
    }
  }
  return files;
}

export interface ParsedFeature {
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

/**
 * Parses one feature file's already-read source into a `GherkinDocument`
 * plus the pickles `compile()` expands from it. A fresh id generator and
 * parser per call: AstBuilder accumulates parse state (its own node stack),
 * so reusing one across files would risk one file's state leaking into the
 * next after a parse error. Throws whatever `@cucumber/gherkin` throws on
 * malformed input — callers decide how to report that (a per-file entry
 * here, a setup failure in `nuka run`).
 */
export function parseFeatureSource(source: string, relativePath: string): ParsedFeature {
  const newId = IdGenerator.uuid();
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
  const gherkinDocument = parser.parse(source);
  const pickles = compile(gherkinDocument, relativePath, newId);
  return { gherkinDocument, pickles };
}

/**
 * Every AST node in `gherkinDocument` that has both an `id` and a
 * `location`, keyed by that id. `PickleStep` itself never carries a
 * location (`@cucumber/messages`'s own shape has only `astNodeIds`, pointers
 * back into this document) — this map is what turns an id back into the
 * line it sits on. Only a Step's own id and an Examples row's own id are
 * ever named by a pickle step's `astNodeIds` (`@cucumber/gherkin`'s own
 * `compile()`), so those are the two kinds of node collected; a Feature,
 * Scenario, or Background node's own id is never looked up through a pickle
 * step and is left out.
 */
export function buildAstNodeLineMap(gherkinDocument: GherkinDocument): ReadonlyMap<string, number> {
  const lineById = new Map<string, number>();
  const feature = gherkinDocument.feature;
  if (feature === undefined) {
    return lineById;
  }

  const addSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      lineById.set(step.id, step.location.line);
    }
  };

  const addScenario = (scenario: Scenario): void => {
    addSteps(scenario.steps);
    for (const examples of scenario.examples) {
      for (const row of examples.tableBody) {
        lineById.set(row.id, row.location.line);
      }
    }
  };

  for (const child of feature.children) {
    if (child.background) {
      addSteps(child.background.steps);
    } else if (child.scenario) {
      addScenario(child.scenario);
    } else if (child.rule) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background) {
          addSteps(ruleChild.background.steps);
        } else if (ruleChild.scenario) {
          addScenario(ruleChild.scenario);
        }
      }
    }
  }

  return lineById;
}

/** A pickle step plus the line it sits on in the original `.feature` source
 * — `undefined` only if `astNodeIds` names an id `buildAstNodeLineMap`
 * didn't collect, which never happens for a document `compile()` produced
 * these pickles from (defensive, not an observed case). */
export interface FeaturePickleStep extends PickleStep {
  readonly line: number | undefined;
}

export interface FeaturePickle extends Pickle {
  readonly steps: readonly FeaturePickleStep[];
}

/**
 * Resolves every pickle step's own line via `buildAstNodeLineMap` and
 * `astNodeIds[0]` — always the step's own AST node id, whether the step
 * came from a Background, a Scenario, or a Scenario Outline template
 * (`@cucumber/gherkin`'s own `compile()` puts it first every time and, for
 * an outline, only appends the Examples row's id after it). Reading the
 * step's own id rather than the row's id means an outline finding points at
 * the templated step line to edit, not the data row that happened to
 * interpolate into the failing text.
 */
export function attachStepLines(
  pickles: readonly Pickle[],
  gherkinDocument: GherkinDocument,
): readonly FeaturePickle[] {
  const lineById = buildAstNodeLineMap(gherkinDocument);
  return pickles.map((pickle) => ({
    ...pickle,
    steps: pickle.steps.map((step) => {
      const stepNodeId = step.astNodeIds[0];
      return { ...step, line: stepNodeId === undefined ? undefined : lineById.get(stepNodeId) };
    }),
  }));
}

const SERIAL_TAG = "@nukadoko:serial";

/**
 * Every `@nukadoko:serial` tag this document carries on a `Scenario:`/`Scenario
 * Outline:` line directly (a Rule's own scenarios included), never one
 * inherited from the `Feature:` line: a gherkin AST node's own `tags` array
 * holds only what was written on that exact line, so this needs the
 * document itself, not a pickle's `tags` (`@cucumber/gherkin`'s `compile()`
 * merges Feature + Rule + Scenario tags onto every pickle, which is exactly
 * what would make the two indistinguishable). Called where
 * `parseFeatureSource`'s own `gherkinDocument` is still in hand, before a
 * caller that has no use for it (`nuka run`'s own directory walk) drops it.
 */
export function findSerialTagOnScenario(
  gherkinDocument: GherkinDocument,
  relativePath: string,
): readonly SerialTagOnScenario[] {
  const feature = gherkinDocument.feature;
  if (feature === undefined) {
    return [];
  }

  const issues: SerialTagOnScenario[] = [];
  const checkScenario = (scenario: Scenario): void => {
    if (scenario.tags.some((tag) => tag.name === SERIAL_TAG)) {
      issues.push({ relativePath, line: scenario.location.line, name: scenario.name });
    }
  };

  for (const child of feature.children) {
    if (child.scenario) {
      checkScenario(child.scenario);
    } else if (child.rule) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.scenario) {
          checkScenario(ruleChild.scenario);
        }
      }
    }
  }
  return issues;
}

export interface LoadFeaturesFromDirsResult extends LoadFeaturesResult {
  /** Which `additionalFeatureDirs` entries (never `featuresDir` — see this
   * file's own header) do not exist on disk, in the order they were given. */
  readonly missingAdditionalDirs: readonly string[];
}

/**
 * Walks `featuresDir` plus every `additionalFeatureDirs` entry
 * (this file's own header), de-duplicating a file reachable from more than
 * one of them by its absolute path.
 */
export function loadFeaturesFromDirs(
  rootDir: string,
  featuresDir: string,
  additionalFeatureDirs: readonly string[],
): LoadFeaturesFromDirsResult {
  const features: FeatureFile[] = [];
  const parseErrors: FeatureParseError[] = [];
  const missingAdditionalDirs: string[] = [];
  const serialTagOnScenario: SerialTagOnScenario[] = [];
  const seenAbsolutePaths = new Set<string>();

  const collect = (dir: string): void => {
    for (const filePath of walkFeatureFiles(path.join(rootDir, dir))) {
      if (seenAbsolutePaths.has(filePath)) {
        continue;
      }
      seenAbsolutePaths.add(filePath);

      const relativePath = path.relative(rootDir, filePath);
      const source = readFileSync(filePath, "utf8");
      try {
        // This caller (src/check/*.ts, src/tend/*.ts) has no hook to run
        // against, so it never keeps the `gherkinDocument`
        // `parseFeatureSource` also returns the way `nuka run`'s own path
        // (src/run/select-pickles.ts onward to src/run/run-scenario.ts)
        // does — it is only read here, through `attachStepLines` and
        // `findSerialTagOnScenario`, to give each pickle step its own line
        // and to catch a `@nukadoko:serial` tag in the one place it has no effect,
        // before the document itself is dropped.
        const { gherkinDocument, pickles } = parseFeatureSource(source, relativePath);
        features.push({ relativePath, pickles: attachStepLines(pickles, gherkinDocument) });
        serialTagOnScenario.push(...findSerialTagOnScenario(gherkinDocument, relativePath));
      } catch (error) {
        parseErrors.push({
          relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // featuresDir is fail-open (walkFeatureFiles itself tolerates a missing
  // directory) — a missing featuresDir already has its own,
  // differently-worded report (config-check.ts's features-dir-missing).
  collect(featuresDir);

  for (const dir of additionalFeatureDirs) {
    if (!existsSync(path.join(rootDir, dir))) {
      missingAdditionalDirs.push(dir);
      continue;
    }
    collect(dir);
  }

  return { features, parseErrors, serialTagOnScenario, missingAdditionalDirs };
}
