import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";

// Responsibility: whether `nuka report --out` names a place this render can
// write, and creating the directories it needs on the way there. A missing
// directory is created, since the caller named the path; anything else in
// the way is a refusal that says what is there. Boundary: no rendering;
// src/cli/report.ts calls this before it writes and refuses with the
// message it returns.
//
// Why the parents are created one at a time, never with `mkdirSync(dir,
// { recursive: true })`: on Node 24 that call never returns for a path
// under `/proc` (it retries the ENOENT that procfs gives forever, at full
// CPU), and it reports a regular file in the way only as ENOTDIR on the
// whole path. One `mkdirSync` per missing component fails once, with the
// component that failed.
//
// Every message starts with `label`: the `--out` value as the caller typed
// it, or "the default allure directory <path>" when there was no `--out`,
// so the refusal names what the caller chose rather than a parent of it.

export type OutKind = "file" | "dir";

function statOf(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** True when `target` is a symbolic link whose target does not exist:
 * `stat` cannot see it, but `mkdir` and `open` are still refused there
 * (EEXIST), or, for a file, would create a file wherever the link points. */
function isDanglingLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink() && statOf(target) === null;
  } catch {
    return false;
  }
}

/** `target` with its nearest existing ancestor replaced by that ancestor's
 * real path, so a link or a different letter case on the way cannot hide
 * which file a write would reach. */
function realTarget(target: string): string {
  const rest: string[] = [];
  let current = path.resolve(target);
  while (true) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const up = path.dirname(current);
      if (up === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = up;
    }
  }
}

/** Where a render must never write: the Allure history file, matched by
 * name in any letter case in the export directory (a case-insensitive file
 * system makes every spelling the same file), after links on the way are
 * resolved (an alias of the export directory reaches the same file). */
export interface ReservedFile {
  readonly dir: string;
  readonly name: string;
  readonly why: string;
}

/** What `target` holds that this render cannot write to, or `null` when it
 * can: a file target must be missing or a regular file, a directory target
 * missing or a directory, and the nearest existing parent a directory. */
export function outTargetProblem(target: string, kind: OutKind, label: string, shown: (absolute: string) => string, reserved?: ReservedFile): string | null {
  if (reserved !== undefined) {
    const real = realTarget(target);
    const realDir = realTarget(reserved.dir);
    if (path.basename(real).toLowerCase() === reserved.name.toLowerCase() && path.dirname(real) === realDir) {
      return `${label} names ${reserved.why}, so it is not written`;
    }
  }
  if (isDanglingLink(target)) return `${label} is a dangling symbolic link, so nothing is written through it`;
  const own = statOf(target);
  if (own !== null) {
    if (kind === "file" && own.isDirectory()) return `${label} is a directory; markdown and messages write one file`;
    if (kind === "file" && !own.isFile()) return `${label} is not a regular file (a FIFO, a socket, or a device), so it is not written`;
    if (kind === "dir" && !own.isDirectory()) return `${label} is not a directory; allure writes a directory of results`;
    return null;
  }
  let parent = path.dirname(target);
  while (true) {
    if (isDanglingLink(parent)) return `${label} lies under ${shown(parent)}, a dangling symbolic link`;
    const stats = statOf(parent);
    if (stats !== null) {
      return stats.isDirectory() ? null : `${label} lies under ${shown(parent)}, which is not a directory`;
    }
    const up = path.dirname(parent);
    if (up === parent) return null;
    parent = up;
  }
}

/** Creates `dir` and each missing parent, one component at a time, and
 * returns the problem when one cannot be created. */
export function createOutDir(dir: string, label: string, shown: (absolute: string) => string): string | null {
  const missing: string[] = [];
  let current = path.resolve(dir);
  while (statOf(current) === null) {
    missing.unshift(current);
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  for (const component of missing) {
    try {
      mkdirSync(component);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      if (code === "EEXIST" && statOf(component)?.isDirectory() === true) continue;
      return `${label}: could not create ${shown(component)} (${code})`;
    }
  }
  return null;
}

/** Writes one file target, returning the problem instead of throwing: the
 * checks above see only what is there, and a write can still be refused
 * (a read-only or permission-denied directory, a file under /proc). */
export function writeOutFile(target: string, text: string, label: string): string | null {
  try {
    writeFileSync(target, text);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    return `${label}: could not write it (${code})`;
  }
}
