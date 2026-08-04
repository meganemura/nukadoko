import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from "@cucumber/gherkin";
import { IdGenerator, type GherkinDocument, type Pickle } from "@cucumber/messages";

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
// m21b-compat-execution task spec, item 3: `parseFeatureSource` used to
// parse, then keep only `compile()`'s pickles and throw away `parser.parse`'s
// own `GherkinDocument` — the exact document a Before/After hook's
// `HookParameter.gherkinDocument` needs (src/compat/hooks.ts). Returning it
// alongside the pickles, rather than reconstructing or half-populating one
// later, is what keeps a hook's `gherkinDocument` from becoming its own new
// "silently read something undefined/partial" gap (this task's own reason
// for existing).

export interface FeatureFile {
  readonly relativePath: string;
  readonly pickles: readonly Pickle[];
}

export interface FeatureParseError {
  readonly relativePath: string;
  readonly message: string;
}

export interface LoadFeaturesResult {
  readonly features: readonly FeatureFile[];
  readonly parseErrors: readonly FeatureParseError[];
}

function walkFeatureFiles(dir: string): string[] {
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
        // against, so its own `FeatureFile` keeps `pickles` only; the
        // `gherkinDocument` `parseFeatureSource` also returns is exclusively
        // for `nuka run`'s own path (src/run/select-pickles.ts) onward to
        // src/run/run-scenario.ts.
        const { pickles } = parseFeatureSource(source, relativePath);
        features.push({ relativePath, pickles });
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

  return { features, parseErrors, missingAdditionalDirs };
}
