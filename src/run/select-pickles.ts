import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import {
  parseFeatureSource,
  realPathOrSelf,
  walkFeatureFiles,
  type FeatureParseError,
} from "../feature/load-features.js";
import {
  DirectoryTargetLineError,
  FeatureFileNotFoundError,
  FeatureParseFailedError,
  FeatureReadFailedError,
  MarkdownTargetError,
  NoFeatureFilesFoundError,
  NoMatchingScenarioError,
} from "./errors.js";

export { DirectoryTargetLineError };

// Responsibility: turn `nuka run`'s `<feature[:line]>|<dir>` arguments into
// the pickles they select, as one sorted and deduplicated file set. This is
// the one place that each argument's syntax and
// gherkin's own pickle `location` are both known. A missing file, a parse
// failure, `:line` matching zero pickles, a directory carrying `:line`, or
// a directory with no `.feature` file anywhere under it, or a Markdown file, are all setup
// failures, thrown here before anything about the run is decided; cli/
// run.ts turns them into stderr + exit 1 the same way it already does for
// config/environment errors.
//
// Each positional also accepts a directory. `selectPickles` decides
// file-vs-directory by `statSync`, tried first: a path that doesn't exist
// at all falls straight through to the same `readFileSync`-then-catch that
// already raises `FeatureFileNotFoundError` for a file target, so that
// error's own wording and behavior for "nothing at this path" is
// unchanged. A directory is walked recursively for `.feature` files
// via src/feature/load-features.ts's own `walkFeatureFiles` (reused, not
// duplicated), which skips `node_modules` and dot-directories and reports
// nothing about that skip. The result is re-sorted by rootDir-relative path in plain byte
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
  /** The text the document was parsed from, which the run keeps in its
   * sources.json so `nuka report` parses the same scenarios later. */
  readonly source: string;
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
   * loop; grouped by file is kept here because sources.json
   * (src/record/run-sources.ts) keeps one entry per file. */
  readonly features: readonly SelectedFeature[];
  /** How many pickles the target has in total, whether or not `:line` cut
   * a single file's own selection down. A directory target never filters,
   * so this always equals the sum of every feature's own `pickles.length`. */
  readonly totalPickles: number;
}

function readFeatureSource(rootDir: string, relativePath: string): string {
  try {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FeatureFileNotFoundError(relativePath);
    }
    throw new FeatureReadFailedError(relativePath, error);
  }
}

function parseSelectedSource(relativePath: string, source: string): SelectedFeature {
  const { gherkinDocument, pickles } = parseFeatureSource(source, relativePath);
  return { relativePath, gherkinDocument, pickles, source, selectedLines: null };
}

/** One selected file for `nuka run`: a file that does not parse refuses
 * the run, since none of its scenarios can be executed. */
function readSelectedFeature(rootDir: string, relativePath: string): SelectedFeature {
  const source = readFeatureSource(rootDir, relativePath);
  try {
    return parseSelectedSource(relativePath, source);
  } catch (error) {
    throw new FeatureParseFailedError(relativePath, error);
  }
}

/**
 * The selected files for `nuka check`, which reports a file that does not
 * parse as a `feature-parse-error` finding beside every other file's
 * findings, the same as its walk of featuresDir does. A file that cannot
 * be read is still a refusal: the target is wrong, not the file.
 */
export function readFeaturesForCheck(
  rootDir: string,
  relativePaths: readonly string[],
): { readonly features: readonly SelectedFeature[]; readonly parseErrors: readonly FeatureParseError[] } {
  const features: SelectedFeature[] = [];
  const parseErrors: FeatureParseError[] = [];
  for (const relativePath of relativePaths) {
    const source = readFeatureSource(rootDir, relativePath);
    try {
      features.push(parseSelectedSource(relativePath, source));
    } catch (error) {
      parseErrors.push({
        relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { features, parseErrors };
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

/** Which lines of one selected file run: `null` selects the whole file. */
export type SelectedFileLines = ReadonlySet<number> | null;

/**
 * Resolves `nuka run`'s targets to the files they select, sorted in byte
 * order, without reading any of them. A target is a directory when it
 * resolves (`statSync`) to one; every other case, including a path that
 * doesn't exist at all, is a single-file target, which the read in
 * `readSelectedFeature` then reports.
 */
export function resolveFeatureTargets(
  rootDir: string,
  featureArgs: readonly string[],
): ReadonlyArray<readonly [string, SelectedFileLines]> {
  const selections = new Map<string, Set<number> | null>();
  // Two targets can reach one file by different paths, such as a linked
  // directory and the directory it points to. Keying on the real path runs
  // that file once, under the first path seen.
  const firstPathByRealPath = new Map<string, string>();
  const selectionKey = (relativePath: string): string => {
    const realPath = realPathOrSelf(path.join(rootDir, relativePath));
    const firstPath = firstPathByRealPath.get(realPath);
    if (firstPath !== undefined) {
      return firstPath;
    }
    firstPathByRealPath.set(realPath, relativePath);
    return relativePath;
  };
  const scannedDirectories: { readonly relativePath: string; readonly absolutePath: string }[] = [];
  let directoryLine: { readonly relativePath: string; readonly line: number } | null = null;
  const targetsWithoutDirectoryLine: string[] = [];

  for (const featureArg of featureArgs) {
    const target = parseFeatureTarget(featureArg);
    const absolutePath = path.join(rootDir, target.relativePath);
    const normalizedRelativePath = path.relative(rootDir, path.resolve(rootDir, target.relativePath));
    if (/\.md$/i.test(target.relativePath)) {
      throw new MarkdownTargetError(target.relativePath);
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(absolutePath).isDirectory();
    } catch {
      isDirectory = false;
    }

    targetsWithoutDirectoryLine.push(isDirectory ? target.relativePath : featureArg);
    if (isDirectory) {
      if (target.line !== null) {
        directoryLine ??= { relativePath: target.relativePath, line: target.line };
        continue;
      }
      scannedDirectories.push({ relativePath: target.relativePath, absolutePath });
      for (const relativePath of featureFilesInDirectory(rootDir, target.relativePath)) {
        selections.set(selectionKey(relativePath), null);
      }
      continue;
    }

    const key = selectionKey(normalizedRelativePath);
    if (target.line === null) {
      selections.set(key, null);
      continue;
    }

    if (selections.get(key) === null && selections.has(key)) {
      continue;
    }
    const lines = selections.get(key) ?? new Set<number>();
    lines.add(target.line);
    selections.set(key, lines);
  }

  if (directoryLine !== null) {
    throw new DirectoryTargetLineError(directoryLine.relativePath, directoryLine.line, targetsWithoutDirectoryLine);
  }

  if (selections.size === 0) {
    const relativePaths = scannedDirectories.map(({ relativePath }) => relativePath);
    const absolutePaths = scannedDirectories.map(({ absolutePath }) => absolutePath).join(", ");
    throw new NoFeatureFilesFoundError(relativePaths, absolutePaths);
  }

  return [...selections.entries()].sort(([a], [b]) => compareByteOrder(a, b));
}

/**
 * Loads the `.feature` file(s) `featureArgs` names and selects which of
 * their pickles `nuka run` executes: every pickle, in file order, when no
 * `:line` was given, or (a single-file target only) only the pickle(s)
 * whose own gherkin `location.line` equals it. A Scenario Outline's
 * Examples row counts, since `@cucumber/gherkin`'s `compile()` assigns
 * each expanded pickle the location of the row that produced it, not the
 * outline's own line.
 */
export function selectPickles(
  rootDir: string,
  featureArgs: string | readonly string[],
): SelectedScenarios {
  const args = typeof featureArgs === "string" ? [featureArgs] : featureArgs;
  let totalPickles = 0;
  const features = resolveFeatureTargets(rootDir, args).map(
    ([relativePath, selectedLines]) => {
      const feature = readSelectedFeature(rootDir, relativePath);
      totalPickles += feature.pickles.length;
      if (selectedLines === null) {
        return feature;
      }
      for (const line of selectedLines) {
        if (!feature.pickles.some((pickle) => pickle.location?.line === line)) {
          const scenarioLines = [
            ...new Set(feature.pickles.flatMap((pickle) => (pickle.location === undefined ? [] : [pickle.location.line]))),
          ].sort((a, b) => a - b);
          throw new NoMatchingScenarioError(relativePath, line, scenarioLines);
        }
      }
      const pickles = feature.pickles.filter((pickle) => selectedLines.has(pickle.location?.line ?? 0));
      return { ...feature, pickles, selectedLines: [...selectedLines].sort((a, b) => a - b) };
    },
  );

  return { features, totalPickles };
}
