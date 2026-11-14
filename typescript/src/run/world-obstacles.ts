import path from "node:path";
import { within } from "./trees.js";

// Responsibility: what keeps `nuka run --base` from building the base or
// the old world faithfully (docs/spec.md "Verdicts"), read once from what
// is known of the two sides before any tree is made: head's working tree
// and the links on disk, the ref's entries and their git modes, the feature
// files the run selected, and the packages linked under `node_modules`.
// Boundary: pure. Listing the entries and reading the disk is
// src/run/base-run.ts's; leaving a world's cells not run, and the findings
// of the rows that turns red, are src/cli/run.ts's and
// src/run/verdict-table.ts's.
//
// Each kind below is a shape in which a tree cannot hold the mix its world
// names, and which nukadoko does not support yet. A world with an obstacle is not
// built, and its cells say why, which is honest where a tree that ran the
// other side's files would not be: a symbolic link resolves to whatever its
// target is in the tree it lands in, a feature file outside the features
// directory is copied with neither side's mapping, a workspace package
// links the base's code to head's copy, and a submodule's or a nested
// repository's files are not the side's own. Where the obstacle also hides
// part of the mapping from the comparison, the mapping counts as changed,
// so an unchanged row needs the old world and is never held on a
// comparison that could not see it.

export type ObstacleWorld = "base" | "old";

/** What a side holds at a path: a file, a symbolic link, or a repository
 * of its own (a submodule's gitlink, or a directory holding its own
 * `.git`). */
export type EntryKind = "file" | "link" | "repository";

export interface SideEntry {
  /** Relative to the repository's top, with `/` separators. */
  readonly path: string;
  readonly kind: EntryKind;
}

/** One side as the comparison reads it. Paths are relative to the
 * repository's top. */
export interface ObstacleSide {
  readonly entries: readonly SideEntry[];
  readonly featuresDir: string;
  /** The config file, or `null` when the side has none. */
  readonly config: string | null;
}

export interface ObstacleFacts {
  /** The project's directory, relative to the repository's top (`""` at
   * the top): an obstacle names its path from there, as every path
   * nukadoko prints. */
  readonly project: string;
  readonly head: ObstacleSide;
  readonly ref: ObstacleSide;
  /** Each feature file the run selected from, relative to the
   * repository's top. */
  readonly features: readonly string[];
  /** Each package under the project's or the repository top's
   * `node_modules` that is a symbolic link, with the path it resolves to
   * relative to the repository's top, or `null` when that is outside it. */
  readonly linkedPackages: readonly { readonly path: string; readonly target: string | null }[];
}

export type ObstacleKind = "link" | "outside-features" | "workspace-package" | "nested-repository";

export interface WorldObstacle {
  readonly world: ObstacleWorld;
  readonly kind: ObstacleKind;
  /** Relative to the project root. */
  readonly path: string;
  /** Why the world is not built, as its cells say it. */
  readonly reason: string;
  /** The edit that lets `--base` build the world, when one does. */
  readonly fix?: string;
}

export interface WorldObstacles {
  /** Sorted by world, kind, and path. */
  readonly obstacles: readonly WorldObstacle[];
  /** Why the mapping comparison cannot see each side's mapping whole,
   * sorted; empty when it can. */
  readonly mappingUnseen: readonly string[];
}

/** The kind of entry a git mode names. Pure. */
export function entryKindOfMode(mode: string): EntryKind {
  if (mode === "120000") return "link";
  if (mode === "160000") return "repository";
  return "file";
}

const BOTH: readonly ObstacleWorld[] = ["base", "old"];

// One row per kind: which worlds it keeps from being built, and what it
// says. The order is the order obstacles are reported in.
const KINDS: Readonly<
  Record<
    ObstacleKind,
    {
      readonly worlds: readonly ObstacleWorld[];
      readonly reason: (at: string, featuresDir: string) => string;
      readonly fix?: (at: string, featuresDir: string) => string;
    }
  >
> = {
  link: {
    worlds: BOTH,
    reason: (at) => `${at} is a symbolic link in the criteria or the mapping, and --base does not follow symbolic links yet`,
    fix: (at) => `replace the symbolic link ${at} with the files it points to`,
  },
  "outside-features": {
    worlds: BOTH,
    reason: (at, featuresDir) => `${at} is outside the features directory ${featuresDir}, and --base compares only the criteria and steps under it`,
    fix: (at, featuresDir) => `move ${at} under ${featuresDir}`,
  },
  "workspace-package": {
    worlds: ["base"],
    reason: (at) => `${at} links to a package inside the repository, so the base world would run head's copy of it as the base's code, and --base does not support workspace packages yet`,
  },
  "nested-repository": {
    worlds: BOTH,
    reason: (at) => `${at} is a submodule or a repository of its own, and --base does not support submodules or nested repositories yet`,
  },
};
const ORDER = Object.keys(KINDS) as ObstacleKind[];

interface Found {
  readonly kind: ObstacleKind;
  readonly path: string;
  /** Whether it hides part of the mapping from the comparison. */
  readonly hidesMapping: boolean;
}

function above(entryPath: string, dir: string): boolean {
  return dir.startsWith(`${entryPath}/`);
}

function inMapping(entryPath: string, side: ObstacleSide): boolean {
  return within(entryPath, side.featuresDir) || above(entryPath, side.featuresDir) || entryPath === side.config;
}

/** What keeps each world from being built faithfully, and whether the
 * mapping comparison can be trusted (module header). The result does not
 * depend on the order of any list it is given. Pure. */
export function worldObstacles(facts: ObstacleFacts): WorldObstacles {
  const finds: Found[] = [];
  for (const side of [facts.head, facts.ref]) {
    for (const entry of side.entries) {
      if (entry.kind === "link" && inMapping(entry.path, side)) finds.push({ kind: "link", path: entry.path, hidesMapping: true });
      if (entry.kind === "repository") finds.push({ kind: "nested-repository", path: entry.path, hidesMapping: inMapping(entry.path, side) });
    }
  }
  for (const feature of facts.features) {
    if (!within(feature, facts.head.featuresDir)) finds.push({ kind: "outside-features", path: feature, hidesMapping: true });
  }
  for (const linked of facts.linkedPackages) {
    if (linked.target !== null && !linked.target.split("/").includes("node_modules")) finds.push({ kind: "workspace-package", path: linked.path, hidesMapping: false });
  }
  const shown = (entryPath: string): string => path.posix.relative(facts.project, entryPath) || ".";
  const featuresDir = shown(facts.head.featuresDir);
  const obstacles = new Map<string, WorldObstacle>();
  const unseen = new Set<string>();
  for (const found of finds) {
    const row = KINDS[found.kind];
    const at = shown(found.path);
    const reason = row.reason(at, featuresDir);
    if (found.hidesMapping) unseen.add(reason);
    for (const world of row.worlds) {
      obstacles.set(`${world}\u0000${found.kind}\u0000${at}`, {
        world,
        kind: found.kind,
        path: at,
        reason,
        ...(row.fix === undefined ? {} : { fix: row.fix(at, featuresDir) }),
      });
    }
  }
  const sorted = [...obstacles.values()].sort(
    (a, b) => BOTH.indexOf(a.world) - BOTH.indexOf(b.world) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return { obstacles: sorted, mappingUnseen: [...unseen].sort() };
}
