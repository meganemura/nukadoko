import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { Conditions } from "../condition/condition.js";
import { CONFIG_FILE_NAMES, loadConfig } from "../config/load-config.js";
import { loadProgram, PROGRAM_FILE_NAMES } from "../config/load-program.js";
import type { Program } from "../config/program-schema.js";
import type { NukadokoConfig } from "../config/schema.js";
import { defaultEnvironmentNames } from "../environment/resolve-environment.js";
import { parseFeatureSource, walkFeatureFiles } from "../feature/load-features.js";
import type { RunMappingChanges } from "../record/run-result.js";
import { runsRelativeDir } from "../record/state-layout.js";
import { compareCriteria, criteriaOfFeature, criterionKey, type CriteriaComparison, type Criterion, type CriterionChange } from "./criteria.js";
import { addWorktree, NO_HOOKS, removeStaleTreeRegistrations, removeWorktree, repositoryPlace, trackedEntries, workingTreeFiles } from "./git-ref.js";
import { compareMapping, configMappingText, programMappingOf, type MappingComparison, type MappingSnapshot } from "./mapping.js";
import { runOnce } from "./process-signal.js";
import { overlayBaseTree, within, writeOldTree, type TreeInput, type TreeSide } from "./trees.js";
import { entryKindOfMode, worldObstacles, type EntryKind, type SideEntry, type WorldObstacle } from "./world-obstacles.js";
export { projectRelativeText } from "./trees.js";
export type { ObstacleKind, ObstacleWorld, WorldObstacle } from "./world-obstacles.js";

export { criterionKey, type CriteriaComparison, type Criterion, type CriterionChange, type CriterionPlace } from "./criteria.js";
export type { MappingComparison } from "./mapping.js";
export { fetchCommandFor, GitRefError, removeStaleTreeRegistrations, resolveRef, type RefResolution } from "./git-ref.js";

// Responsibility: what `nuka run --base <ref>` knows before head's pass
// runs (docs/spec.md "Verdicts"): the ref's criteria and how each selected
// criterion compares with them, whether the mapping changed, and the base
// and the old tree on disk under the run's directory, each made only when
// a row may need it. Boundary: the comparisons are src/run/criteria.ts's and
// src/run/mapping.ts's, the files a tree holds src/run/trees.ts's, git
// src/run/git-ref.ts's; running a pass in a tree is src/run/tree-pass.ts's,
// and when it runs is src/cli/run.ts's.
//
// The trees are made before head's pass, from head's working tree as the
// run found it, so a step that writes into the project does not change what
// the old world runs. The old tree is copied first, from the ref's checkout
// while that is still pristine, and then the checkout becomes the base tree.
//
// Dependencies: no tree gets a `node_modules` of its own, and nothing is
// installed. Both trees sit inside head's project, so a package a tree's
// file imports, the nukadoko its step files import among them, resolves
// upward to head's, the one the running engine was loaded from, and
// `npm run` finds head's tools the same way. The base tree builds its
// program with its own build commands against head's packages; a change
// that also changed the dependencies builds the base against head's
// versions, which the build fails on or the cells show. A dependency kept
// outside the project (Ruby gems, a system tool) is the machine's, the same
// one head's program uses.
//
// The ref's config and program file are loaded to read its features
// directory and its mapping part. One that does not load at the ref is a
// mapping that cannot be shown to be head's, so it counts as changed, and
// the old world, which runs that mapping, then says it could not run.
// The old world's environments are that mapping too: the ones the ref's
// program file selects for the run's `--env` names, each with the
// conditions the ref gives it, so a row is asked to hold where the base
// asked it to, and the old world starts head's recipe of the same name.
//
// A features directory at the project root holds the program's code too,
// so "the mapping" would be the whole project and the base tree would be
// head's: that run is refused instead (`BaseSetupError`).
//
// Some shapes keep a tree from holding the mix its world names
// (src/run/world-obstacles.ts). They are read once, from the checkout of
// the ref and head's working tree, before either tree is made: a world
// with an obstacle is not made, and where an obstacle hides part of the
// mapping, the mapping counts as changed.

/** A `--base` run that cannot be compared, before anything ran. */
export class BaseSetupError extends Error {}

/** One feature file as the ref holds it, for the old world's records. */
export interface RefFeature {
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

/** A tree a pass runs in. */
export interface PreparedTree {
  /** The tree's project root: where its config, program file, and
   * features are. */
  readonly root: string;
}

export interface PreparedBase {
  readonly ref: string;
  readonly commit: string;
  readonly criteria: CriteriaComparison;
  readonly mapping: MappingComparison;
  /** `mapping` as run.json's `table.mapping_changes` says it. */
  readonly mappingChanges: RunMappingChanges;
  /** `null` when no selected row is new or changed, or the base world has
   * an obstacle. */
  readonly base: (PreparedTree & { readonly programFromHead: boolean }) | null;
  /** `null` unless a selected row is unchanged and the mapping changed or
   * the row was retagged, and the old world has no obstacle. */
  readonly old: PreparedTree | null;
  /** What keeps the base or the old world from being made, sorted by
   * world: each world named here is `null` above. */
  readonly obstacles: readonly WorldObstacle[];
  /** The environments the old world runs in, with the conditions the
   * ref's program file gives each (module header); `null` when the ref
   * has no program file and head's are the old world's, and why when it
   * did not load. */
  readonly oldEnvironments: readonly OldEnvironment[] | null | { readonly problem: string };
  /** The ref's feature files that were compared, by path relative to the
   * project root. */
  readonly refFeatures: ReadonlyMap<string, RefFeature>;
  /** Feature files at the ref that did not parse: their criteria could
   * not be compared, so head's count as new. */
  readonly unparsed: readonly { readonly feature: string; readonly message: string }[];
  /** Removes both trees. */
  cleanup(): Promise<void>;
}

/** One environment of the old world, as the ref's program file has it. */
export interface OldEnvironment {
  readonly name: string;
  readonly conditions: Conditions | undefined;
}

export interface PrepareBaseInput {
  readonly rootDir: string;
  /** The run's `--env` names, empty when it named none. */
  readonly envs: readonly string[];
  readonly config: NukadokoConfig;
  readonly headProgram: Program | null;
  readonly ref: string;
  readonly commit: string;
  /** The run's directory, absolute: the trees go in its `trees/`. */
  readonly runDir: string;
  /** Each feature file head selected from, with its source. */
  readonly features: readonly { readonly relativePath: string; readonly source: string }[];
  /** The selected criteria, by `criterionKey`. */
  readonly selected: ReadonlySet<string>;
  /** The run's targets, relative to the project root, without a line, or
   * `null` when the run was given none and runs the features directory. */
  readonly targets: readonly string[] | null;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function hashOf(file: string): string {
  const hash = createHash("sha256");
  const stats = lstatSync(file);
  hash.update(stats.isSymbolicLink() ? `link:${readlinkSync(file)}` : readFileSync(file));
  return hash.digest("hex");
}

function existing(dir: string, names: readonly string[]): string | null {
  return names.find((name) => existsSync(path.join(dir, name))) ?? null;
}

/** What is on disk at `file`, without following a link: a directory
 * where git lists an entry is a repository of its own. `null` when
 * nothing is. */
function kindOnDisk(file: string): EntryKind | null {
  try {
    const stats = lstatSync(file);
    return stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "repository" : "file";
  } catch {
    return null;
  }
}

/** The links on the way to the features directory and at the config
 * file, which git lists only where it tracks them or sees them. */
function linksAbove(top: string, side: TreeSide): SideEntry[] {
  const parts = side.featuresDir.split("/").filter((part) => part.length > 0);
  const paths = [...parts.map((_, index) => parts.slice(0, index + 1).join("/")), ...(side.config === null ? [] : [side.config])];
  return paths.filter((entry) => kindOnDisk(path.join(top, entry)) === "link").map((entry) => ({ path: entry, kind: "link" }));
}

/** Each package under the project's or the repository top's
 * `node_modules`, scoped ones included, that is a symbolic link, with
 * the path it resolves to relative to the top, or `null` outside it. */
function linkedPackages(top: string, prefix: string): { path: string; target: string | null }[] {
  const realTop = realpathSync(top);
  const found: { path: string; target: string | null }[] = [];
  const names = (dir: string): string[] => {
    try {
      return readdirSync(path.join(top, dir));
    } catch {
      return [];
    }
  };
  for (const modules of new Set([path.posix.join(prefix, "node_modules"), "node_modules"])) {
    const packages = names(modules).flatMap((name) => (name.startsWith("@") ? names(path.posix.join(modules, name)).map((scoped) => `${name}/${scoped}`) : [name]));
    for (const name of packages) {
      const at = path.posix.join(modules, name);
      if (kindOnDisk(path.join(top, at)) !== "link") continue;
      let real: string;
      try {
        real = realpathSync(path.join(top, at));
      } catch {
        continue;
      }
      const relative = path.relative(realTop, real);
      found.push({ path: at, target: relative.startsWith("..") || path.isAbsolute(relative) ? null : toPosix(relative) });
    }
  }
  return found;
}

/** The mapping files of one side: each file under its features directory
 * but a `.feature` file, by its path relative to that directory, hashed
 * from where the side's files are. A repository of its own has no bytes
 * to hash; it is an obstacle that hides the mapping instead. */
function mappingFiles(entries: readonly SideEntry[], featuresDir: string, top: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const { path: file, kind } of entries) {
    if (kind === "repository" || !within(file, featuresDir) || file.endsWith(".feature")) continue;
    hashes.set(path.posix.relative(featuresDir, file), hashOf(path.join(top, file)));
  }
  return hashes;
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The feature files the ref holds at the run's targets. */
function refFeatureFiles(project: string, targets: readonly string[]): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    const absolute = path.join(project, target);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.isDirectory()) for (const file of walkFeatureFiles(absolute)) files.add(file);
    else if (absolute.endsWith(".feature")) files.add(absolute);
  }
  return [...files].sort();
}

/** Compares head with the ref, and makes the trees the rows may need
 * (module header). Throws a BaseSetupError, or a GitRefError from git, with
 * nothing left behind. */
export async function prepareBase(input: PrepareBaseInput): Promise<PreparedBase> {
  const { rootDir, config } = input;
  if (path.posix.normalize(toPosix(config.featuresDir)).replace(/\/+$/, "") === ".") {
    throw new BaseSetupError(
      `nuka run --base needs the scenarios and their steps in a directory of their own, and featuresDir is the project root, where the program's code is too`,
    );
  }
  const { top, prefix } = await repositoryPlace(rootDir);
  await removeStaleTreeRegistrations(rootDir, path.join(rootDir, runsRelativeDir(config.stateDir)));
  const inRepo = (relativePath: string): string => path.posix.join(prefix, toPosix(relativePath));
  const treesDir = path.join(input.runDir, "trees");
  const baseTop = path.join(treesDir, "base");
  const oldTop = path.join(treesDir, "old");
  mkdirSync(treesDir, { recursive: true });
  let worktree = false;
  const removeTrees = async (): Promise<void> => {
    if (worktree) {
      worktree = false;
      try {
        await removeWorktree(top, baseTop);
      } catch {
        rmSync(baseTop, { recursive: true, force: true });
      }
    }
    rmSync(oldTop, { recursive: true, force: true });
    try {
      rmdirSync(treesDir);
    } catch {
      // Not empty after all, or already gone.
    }
  };
  // A run a signal ends exits from inside its handler, past any `finally`:
  // the trees go then too, synchronously, the one way an `exit` listener
  // can.
  const removeTreesNow = (): void => {
    if (worktree) spawnSync("git", [...NO_HOOKS, "-C", top, "worktree", "remove", "--force", "--force", baseTop], { stdio: "ignore" });
    rmSync(baseTop, { recursive: true, force: true });
    rmSync(oldTop, { recursive: true, force: true });
    try {
      rmdirSync(treesDir);
    } catch {
      // Not empty after all, or already gone.
    }
  };
  process.on("exit", removeTreesNow);
  try {
    await addWorktree(top, baseTop, input.commit);
    worktree = true;
    const baseProject = path.join(baseTop, prefix);

    // The ref's own config and program file, read from its pristine
    // checkout before anything is laid over it.
    const refConfigFile = existing(baseProject, CONFIG_FILE_NAMES);
    const refProgramFile = existing(baseProject, PROGRAM_FILE_NAMES);
    let refConfig: NukadokoConfig | { problem: string };
    try {
      refConfig = await loadConfig(baseProject);
    } catch (error) {
      refConfig = { problem: problemOf(error) };
    }
    let refProgram: Program | null | { problem: string };
    try {
      refProgram = (await loadProgram(baseProject))?.program ?? null;
    } catch (error) {
      refProgram = { problem: problemOf(error) };
    }
    const refFeaturesDir = "problem" in refConfig ? config.featuresDir : refConfig.featuresDir;

    // The criteria: the ref's at the run's targets, head's in every file
    // it selected from, whole, so a `:line` target compares the file.
    const refFeatures = new Map<string, RefFeature>();
    const unparsed: { feature: string; message: string }[] = [];
    const refCriteria: Criterion[] = [];
    for (const file of refFeatureFiles(baseProject, input.targets ?? [refFeaturesDir])) {
      const relativePath = path.relative(baseProject, file);
      try {
        const parsed = parseFeatureSource(readFileSync(file, "utf8"), relativePath);
        refFeatures.set(relativePath, parsed);
        refCriteria.push(...criteriaOfFeature(relativePath, parsed.gherkinDocument, parsed.pickles));
      } catch (error) {
        unparsed.push({ feature: relativePath, message: problemOf(error) });
      }
    }
    const headCriteria = input.features.flatMap((feature) => {
      const parsed = parseFeatureSource(feature.source, feature.relativePath);
      return criteriaOfFeature(feature.relativePath, parsed.gherkinDocument, parsed.pickles);
    });
    const criteria = compareCriteria(refCriteria, headCriteria);

    // The mapping: head's from its working tree, the ref's from its
    // checkout.
    const headConfigFile = existing(rootDir, CONFIG_FILE_NAMES);
    const headProgramFile = existing(rootDir, PROGRAM_FILE_NAMES);
    const headSide: TreeSide = {
      featuresDir: inRepo(config.featuresDir),
      config: headConfigFile === null ? null : inRepo(headConfigFile),
      program: headProgramFile === null ? null : inRepo(headProgramFile),
    };
    const refSide: TreeSide = {
      featuresDir: inRepo(refFeaturesDir),
      config: refConfigFile === null ? null : inRepo(refConfigFile),
      program: refProgramFile === null ? null : inRepo(refProgramFile),
    };
    // git lists a nested repository with a trailing `/`.
    const headEntries = (await workingTreeFiles(top)).flatMap((file): SideEntry[] => {
      const entry = file.replace(/\/$/, "");
      const kind = kindOnDisk(path.join(top, entry));
      return kind === null ? [] : [{ path: entry, kind }];
    });
    const refEntries = (await trackedEntries(baseTop)).map((entry): SideEntry => ({ path: entry.path, kind: entryKindOfMode(entry.mode) }));
    const headFiles = headEntries.map((entry) => entry.path);
    const refFiles = refEntries.map((entry) => entry.path);
    const found = worldObstacles({
      project: prefix,
      head: { ...headSide, entries: [...headEntries, ...linksAbove(top, headSide)] },
      ref: { ...refSide, entries: refEntries },
      features: input.features.map((feature) => inRepo(feature.relativePath)),
      linkedPackages: linkedPackages(top, prefix),
    });
    const blocked = (world: WorldObstacle["world"]): boolean => found.obstacles.some((obstacle) => obstacle.world === world);
    const headSnapshot: MappingSnapshot = {
      files: mappingFiles(headEntries, headSide.featuresDir, top),
      config: { text: configMappingText(config) },
      program: programMappingOf(input.headProgram),
    };
    const refSnapshot: MappingSnapshot = {
      files: mappingFiles(refEntries, refSide.featuresDir, baseTop),
      config: "problem" in refConfig ? { problem: refConfig.problem } : { text: configMappingText(refConfig) },
      program: refProgram !== null && "problem" in refProgram ? { problem: refProgram.problem } : programMappingOf(refProgram),
    };
    const compared = compareMapping(refSnapshot, headSnapshot);
    const mapping = found.mappingUnseen.length === 0 ? compared : { ...compared, changed: true };

    const changes = [...input.selected].map((key) => criteria.changes.get(key));
    const baseNeeded = !blocked("base") && changes.some((change) => change?.change === "changed" || change?.change === "new");
    const oldNeeded = !blocked("old") && changes.some((change) => change?.change === "unchanged" && (mapping.changed || change.retagged === true));
    const treeInput: TreeInput = { headFiles, refFiles, head: headSide, ref: refSide, stateDir: inRepo(config.stateDir) };
    const roots = { head: top, ref: baseTop };
    if (oldNeeded) writeOldTree(treeInput, roots, oldTop);
    if (baseNeeded) {
      overlayBaseTree(treeInput, roots);
    } else {
      worktree = false;
      await removeWorktree(top, baseTop);
    }
    // The run ends the trees on its normal path and from a signal's
    // handler, which may come while the other is removing them: both wait
    // for the one removal, so the handler never exits halfway through it.
    const cleanup = runOnce(async () => {
      await removeTrees();
      process.off("exit", removeTreesNow);
    });
    return {
      ref: input.ref,
      commit: input.commit,
      criteria,
      mapping,
      mappingChanges: {
        files: mapping.files.map((file) => path.posix.join(toPosix(config.featuresDir), file)),
        config: mapping.config,
        conditions: mapping.conditions,
        default_environments: mapping.defaultEnvironments,
        unseen: found.mappingUnseen,
      },
      base: baseNeeded ? { root: baseProject, programFromHead: refProgramFile === null && headProgramFile !== null } : null,
      old: oldNeeded ? { root: path.join(oldTop, prefix) } : null,
      obstacles: found.obstacles,
      oldEnvironments:
        refProgram === null || "problem" in refProgram
          ? refProgram
          : (input.envs.length > 0 ? input.envs : defaultEnvironmentNames(refProgram)).map((name) => ({
              name,
              conditions: Object.hasOwn(refProgram.environments ?? {}, name) ? refProgram.environments![name]!.conditions : undefined,
            })),
      refFeatures,
      unparsed,
      cleanup,
    };
  } catch (error) {
    await removeTrees();
    process.off("exit", removeTreesNow);
    throw error;
  }
}

/** Where the old world runs an unchanged row: the ref's file and line of
 * each one, by the head row's `criterionKey`, and back. Pure. */
export function oldPlaces(changes: ReadonlyMap<string, CriterionChange>): {
  readonly at: ReadonlyMap<string, { readonly feature: string; readonly line: number }>;
  readonly rowOf: (feature: string, line: number) => string | undefined;
} {
  const at = new Map<string, { feature: string; line: number }>();
  const back = new Map<string, string>();
  for (const [key, change] of changes) {
    if (change.change !== "unchanged") continue;
    at.set(key, change.at);
    back.set(criterionKey(change.at.feature, change.at.line), key);
  }
  return { at, rowOf: (feature, line) => back.get(criterionKey(feature, line)) };
}
