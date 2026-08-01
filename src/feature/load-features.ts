import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from "@cucumber/gherkin";
import { IdGenerator, type Pickle } from "@cucumber/messages";

// Responsibility: walk `featuresDir` for `**/*.feature` files and turn each
// into pickles via @cucumber/gherkin — the official parser owns Background
// merging, Scenario Outline expansion, and table/docstring attachment
// (docs/spec.md "nukadoko deliberately owns as little as possible"). This
// module does not interpret a pickle's steps at all (matching them against
// the vocabulary is src/check/feature-check.ts's job) — it only turns
// `.feature` text into the pickles @cucumber/gherkin produces. A malformed
// feature file is collected as a per-file parse error rather than thrown, so
// one broken file doesn't stop `nuka check` from reporting every other
// feature's issues too (mirrors src/discover/discover-steps.ts's own
// tolerance for a missing featuresDir: an empty/partial answer beats a
// crash).
//
// `parseFeatureSource` is exported so `nuka run` (src/run/select-pickles.ts)
// can parse the one feature file it was pointed at without walking a whole
// directory — the same gherkin invocation, not a second copy of it; that
// module's own errors (missing file, `:line` matching nothing) are its
// business, not this one's.

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

/**
 * Parses one feature file's already-read source into pickles. A fresh id
 * generator and parser per call: AstBuilder accumulates parse state (its own
 * node stack), so reusing one across files would risk one file's state
 * leaking into the next after a parse error. Throws whatever
 * `@cucumber/gherkin` throws on malformed input — callers decide how to
 * report that (a per-file entry here, a setup failure in `nuka run`).
 */
export function parseFeatureSource(source: string, relativePath: string): readonly Pickle[] {
  const newId = IdGenerator.uuid();
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
  const document = parser.parse(source);
  return compile(document, relativePath, newId);
}

export function loadFeatures(rootDir: string, featuresDir: string): LoadFeaturesResult {
  const featuresRoot = path.join(rootDir, featuresDir);
  const filePaths = walkFeatureFiles(featuresRoot);

  const features: FeatureFile[] = [];
  const parseErrors: FeatureParseError[] = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(rootDir, filePath);
    const source = readFileSync(filePath, "utf8");

    try {
      const pickles = parseFeatureSource(source, relativePath);
      features.push({ relativePath, pickles });
    } catch (error) {
      parseErrors.push({
        relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { features, parseErrors };
}
