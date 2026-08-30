import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { parseFeatureSource, walkFeatureFiles } from "../feature/load-features.js";
import {
  DirectoryTargetLineError,
  FeatureFileNotFoundError,
  FeatureParseFailedError,
  NoFeatureFilesFoundError,
  NoMatchingScenarioError,
} from "./errors.js";

// Responsibility: turn `nuka run`'s `<feature[:line]>|<dir>` arguments into
// the pickles they select, as one sorted and deduplicated file set. This is
// the one place that each argument's syntax and
// gherkin's own pickle `location` are both known. A missing file, a parse
// failure, `:line` matching zero pickles, a directory carrying `:line`, or
// a directory with no `.feature` file anywhere under it are all setup
// failures, thrown here before anything about the run is decided; cli/
// run.ts turns them into stderr + exit 1 the same way it already does for
// config/environment errors.
//
// Each positional also accepts a directory. `selectPickles` decides
// file-vs-directory by `statSync`, tried first: a path that doesn't exist
// at all falls straight through to the same `readFileSync`-then-catch that
// already raises `FeatureFileNotFoundError` for a file target, so that
// error's own wording and behavior for "nothing at this path" is
// unchanged. A directory is walked recursively for every `.feature` file
// via src/feature/load-features.ts's own `walkFeatureFiles` (reused, not
// duplicated), then re-sorted here by rootDir-relative path in plain byte
// order — never `localeCompare`, whose collation can legally differ
// between machines/ICU builds, exactly the run-to-run instability this
// sort exists to rule out. `:line` on a directory is refused outright: it
// names one pickle inside a single file's own gherkin `location.line`, and
// a directory names no single file for that to mean anything against.

export interface FeatureTarget {
  readonly relativePath: string;
  /** `null` when no `:line` was given — every pickle in the file runs, in
   * file order. */
  readonly line: number | null;
}

// Matches a trailing `:<digits>` and nothing else, so a feature path itself
// is never mistaken for carrying a line number (there is no legitimate
// `.feature` path ending in `:123` on its own).
const LINE_SUFFIX_PATTERN = /^(.+):(\d+)$/;

export function parseFeatureTarget(featureArg: string): FeatureTarget {
  const match = LINE_SUFFIX_PATTERN.exec(featureArg);
  if (!match) {
    return { relativePath: featureArg, line: null };
  }
  return { relativePath: match[1]!, line: Number(match[2]!) };
}

/** One feature file's own parsed contribution to a run — a directory
 * target is N of these flowing into the same one run, never a different
 * shape. */
export interface SelectedFeature {
  readonly relativePath: string;
  /** This feature file's own parsed document — threaded through to every
   * `runScenario` call for its own pickles so a Before/After hook's
   * `HookParameter.gherkinDocument` is that pickle's real document, never a
   * stand-in and never another file's (a directory target must not let one
   * file's pickle borrow a different file's document). */
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
  /** `null` selects the full file. Otherwise, workers use these lines to
   * preserve this file's partial selection. */
  readonly selectedLines: readonly number[] | null;
}

export interface SelectedScenarios {
  /** One entry per feature file this invocation runs, in the order cli/
   * run.ts's own pickle loop executes them: a single entry for a file
   * target, one entry per file `walkFeatureFiles` found — sorted
   * deterministically, this file's own header — for a directory target.
   * cli/run.ts flattens this into `{ feature, pickle }` pairs for its own
   * loop; grouped by file is kept here because the messages emitter
   * (src/report/messages/emitter.ts) needs that same per-file grouping for
   * its own `begin()` call. */
  readonly features: readonly SelectedFeature[];
  /** How many pickles the target has in total, whether or not `:line` cut
   * a single file's own selection down. A directory target never filters,
   * so this always equals the sum of every feature's own `pickles.length`. */
  readonly totalPickles: number;
}

/**
 * Reads and parses one `.feature` file already known to exist at
 * `relativePath` (rootDir-relative) — the single-file half of
 * `selectPickles`'s own work, factored out so both the file-target branch
 * and the directory-target branch (one call per file the walk found) share
 * it rather than each re-implementing "read, parse, wrap the failure".
 */
function parseOneFeatureFile(rootDir: string, relativePath: string): SelectedFeature {
  const absolutePath = path.join(rootDir, relativePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    throw new FeatureFileNotFoundError(relativePath);
  }

  let gherkinDocument: GherkinDocument;
  let pickles: readonly Pickle[];
  try {
    ({ gherkinDocument, pickles } = parseFeatureSource(source, relativePath));
  } catch (error) {
    throw new FeatureParseFailedError(relativePath, error);
  }

  return { relativePath, gherkinDocument, pickles, selectedLines: null };
}

/** Plain UTF-16 code-unit comparison (`<`/`>`), deliberately not
 * `String.prototype.localeCompare` (this file's own header): for ASCII
 * repo-relative paths this is byte order, and unlike collation it is fixed
 * by the language itself, not by whatever ICU data the running Node build
 * happens to carry. */
function compareByteOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function featureFilesInDirectory(rootDir: string, relativePath: string): string[] {
  const absolutePath = path.join(rootDir, relativePath);
  return walkFeatureFiles(absolutePath)
    .map((absoluteFilePath) => path.relative(rootDir, absoluteFilePath))
    .sort(compareByteOrder);
}

/**
 * Loads the `.feature` file(s) `featureArg` names and selects which of
 * their pickles `nuka run` executes: every pickle, in file order, when no
 * `:line` was given, or (a single-file target only) only the pickle(s)
 * whose own gherkin `location.line` equals it — a Scenario Outline's
 * Examples row included, since `@cucumber/gherkin`'s `compile()` assigns
 * each expanded pickle the location of the row that produced it, not the
 * outline's own line (verified against this repo's own check-clean-project
 * fixture). `featureArg`'s target is a directory when it resolves
 * (`statSync`) to one; every other case, including a path that doesn't
 * exist at all, is a single-file target.
 */
export function selectPickles(rootDir: string, featureArgs: string | readonly string[]): SelectedScenarios {
  const args = typeof featureArgs === "string" ? [featureArgs] : featureArgs;
  const selections = new Map<string, Set<number> | null>();
  const scannedDirectories: { readonly relativePath: string; readonly absolutePath: string }[] = [];

  for (const featureArg of args) {
    const target = parseFeatureTarget(featureArg);
    const absolutePath = path.join(rootDir, target.relativePath);
    const normalizedRelativePath = path.relative(rootDir, path.resolve(rootDir, target.relativePath));
    let isDirectory = false;
    try {
      isDirectory = statSync(absolutePath).isDirectory();
    } catch {
      isDirectory = false;
    }

    if (isDirectory) {
      if (target.line !== null) {
        throw new DirectoryTargetLineError(target.relativePath, target.line);
      }
      scannedDirectories.push({ relativePath: target.relativePath, absolutePath });
      for (const relativePath of featureFilesInDirectory(rootDir, target.relativePath)) {
        selections.set(relativePath, null);
      }
      continue;
    }

    if (target.line === null) {
      selections.set(normalizedRelativePath, null);
      continue;
    }

    if (selections.get(normalizedRelativePath) === null && selections.has(normalizedRelativePath)) {
      continue;
    }
    const lines = selections.get(normalizedRelativePath) ?? new Set<number>();
    lines.add(target.line);
    selections.set(normalizedRelativePath, lines);
  }

  if (selections.size === 0) {
    const relativePaths = scannedDirectories.map(({ relativePath }) => relativePath).join('" and "');
    const absolutePaths = scannedDirectories.map(({ absolutePath }) => absolutePath).join(", ");
    throw new NoFeatureFilesFoundError(relativePaths, absolutePaths);
  }

  let totalPickles = 0;
  const features = [...selections.entries()]
    .sort(([a], [b]) => compareByteOrder(a, b))
    .map(([relativePath, selectedLines]) => {
      const feature = parseOneFeatureFile(rootDir, relativePath);
      totalPickles += feature.pickles.length;
      if (selectedLines === null) {
        return feature;
      }
      for (const line of selectedLines) {
        if (!feature.pickles.some((pickle) => pickle.location?.line === line)) {
          throw new NoMatchingScenarioError(relativePath, line);
        }
      }
      const pickles = feature.pickles.filter((pickle) => selectedLines.has(pickle.location?.line ?? 0));
      return { ...feature, pickles, selectedLines: [...selectedLines].sort((a, b) => a - b) };
    });

  return { features, totalPickles };
}
