import { copyFileSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Responsibility: which files the base and the old tree of `nuka run
// --base` hold, and putting them on disk (docs/spec.md "Verdicts"). The
// base tree is the ref's code under head's criteria and mapping: a
// checkout of the ref with head's features directory and config over it.
// The old tree is head's code under the ref's criteria and mapping: a copy
// of head's working tree with the ref's features directory and config over
// it. The program file goes with the code, so the base tree keeps the
// ref's, and takes head's only when the ref has none. Boundary: the plan is
// pure; the checkout itself is src/run/git-ref.ts's, and when a tree is
// made is src/run/base-run.ts's.
//
// Head's working tree is its tracked files plus the untracked files git
// does not ignore, so an ignored build output or `node_modules` is never
// copied: each tree builds its own program, and resolves packages from the
// directories above it, which hold head's (src/run/base-run.ts says why).
// The state directory is never copied either: the trees live in it.
//
// Every path here is relative to the repository's top with `/`
// separators, since a project can sit in a subdirectory of its repository
// and its code can reach above that directory.

/** Where one tree's file comes from: head's working tree, or the ref. */
export type TreeSource = "head" | "ref";

/** One side of the comparison: where its mapping lives, as paths relative
 * to the repository's top. */
export interface TreeSide {
  readonly featuresDir: string;
  /** The config file, or `null` when the side has none. */
  readonly config: string | null;
  /** The program file, or `null` when the side has none. */
  readonly program: string | null;
}

export interface TreeInput {
  /** Head's working tree: tracked files and untracked ones git does not
   * ignore, each on disk. */
  readonly headFiles: readonly string[];
  /** The files the ref's commit holds. */
  readonly refFiles: readonly string[];
  readonly head: TreeSide;
  readonly ref: TreeSide;
  /** The state directory, which no tree copies. */
  readonly stateDir: string;
}

function normal(relativePath: string): string {
  const posix = path.posix.normalize(relativePath.split(path.sep).join("/"));
  return posix === "." ? "" : posix.replace(/\/+$/, "");
}

/** Whether `file` is `dir` or lies under it. Pure. */
export function within(file: string, dir: string): boolean {
  const root = normal(dir);
  return root === "" || file === root || file.startsWith(`${root}/`);
}

function isMapping(file: string, side: TreeSide): boolean {
  return within(file, side.featuresDir) || (side.config !== null && file === normal(side.config));
}

/** The files the base tree holds, each with where it comes from. Pure. */
export function baseTreeFiles(input: TreeInput): Map<string, TreeSource> {
  const files = new Map<string, TreeSource>();
  for (const file of input.refFiles) if (!isMapping(file, input.ref)) files.set(file, "ref");
  for (const file of input.headFiles) if (isMapping(file, input.head)) files.set(file, "head");
  if (input.ref.program === null && input.head.program !== null) files.set(normal(input.head.program), "head");
  return files;
}

/** The files the old tree holds, each with where it comes from. Pure. */
export function oldTreeFiles(input: TreeInput): Map<string, TreeSource> {
  const files = new Map<string, TreeSource>();
  for (const file of input.headFiles) if (!within(file, input.stateDir) && !isMapping(file, input.head)) files.set(file, "head");
  for (const file of input.refFiles) if (isMapping(file, input.ref)) files.set(file, "ref");
  return files;
}

function copyOne(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  rmSync(to, { force: true, recursive: true });
  // A symbolic link stays one, pointing where it pointed, so a link into
  // the tree still lands in the tree.
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else copyFileSync(from, to);
}

export interface TreeRoots {
  /** Head's working tree, at the repository's top. */
  readonly head: string;
  /** A checkout of the ref, at the repository's top, as it was checked
   * out. */
  readonly ref: string;
}

/** Turns a checkout of the ref at `roots.ref` into the base tree: the
 * ref's mapping goes, and head's comes in. */
export function overlayBaseTree(input: TreeInput, roots: TreeRoots): void {
  const planned = baseTreeFiles(input);
  for (const file of input.refFiles) if (planned.get(file) !== "ref") rmSync(path.join(roots.ref, file), { force: true });
  for (const [file, source] of planned) if (source === "head") copyOne(path.join(roots.head, file), path.join(roots.ref, file));
}

/** Writes the old tree at `dir`, from head's working tree and the checkout
 * of the ref, which has to be untouched yet. */
export function writeOldTree(input: TreeInput, roots: TreeRoots, dir: string): void {
  for (const [file, source] of oldTreeFiles(input)) copyOne(path.join(source === "head" ? roots.head : roots.ref, file), path.join(dir, file));
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with every absolute path under `projectRoot`, as a path or as a
 * file URL, written relative to it, and the root itself as `.`: what a
 * tree's worker or git says names a tree by its absolute path, and every
 * path nukadoko prints is relative to the project. The trees sit inside
 * the project, so their paths read as `.nukadoko/runs/<run_id>/trees/...`.
 * Pure. */
export function projectRelativeText(text: string, projectRoot: string): string {
  const root = projectRoot.replace(/[\\/]+$/, "");
  const url = pathToFileURL(root).href;
  // A longer path that only starts with the root's characters, such as
  // `/work/app2` beside `/work/app`, is another directory and stays.
  const end = "(?=$|[\\s\"'`:;,)\\]]|\\.(?:$|\\s))";
  return text
    .replace(new RegExp(`${escaped(url)}/`, "g"), "")
    .replace(new RegExp(`${escaped(url)}${end}`, "g"), ".")
    .replace(new RegExp(`${escaped(root)}[\\\\/]`, "g"), "")
    .replace(new RegExp(`${escaped(root)}${end}`, "g"), ".");
}
