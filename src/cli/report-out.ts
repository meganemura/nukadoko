import { mkdirSync, statSync, type Stats } from "node:fs";
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

export type OutKind = "file" | "dir";

function statOf(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** What `target` holds that this render cannot write to, or `null` when it
 * can: a file target must be missing or a regular file, a directory target
 * missing or a directory, and the nearest existing parent a directory. */
export function outTargetProblem(target: string, kind: OutKind, shown: (absolute: string) => string): string | null {
  const own = statOf(target);
  if (own !== null) {
    if (kind === "file" && own.isDirectory()) return `--out ${shown(target)} is a directory; markdown and messages write one file`;
    if (kind === "file" && !own.isFile()) return `--out ${shown(target)} is not a regular file (a FIFO, a socket, or a device), so it is not written`;
    if (kind === "dir" && !own.isDirectory()) return `--out ${shown(target)} is not a directory; allure writes a directory of results`;
    return null;
  }
  let parent = path.dirname(target);
  while (true) {
    const stats = statOf(parent);
    if (stats !== null) {
      return stats.isDirectory() ? null : `--out ${shown(target)} lies under ${shown(parent)}, which is not a directory`;
    }
    const up = path.dirname(parent);
    if (up === parent) return null;
    parent = up;
  }
}

/** Creates `dir` and each missing parent, one component at a time, and
 * returns the problem when one cannot be created. */
export function createOutDir(dir: string, shown: (absolute: string) => string): string | null {
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
      return `--out ${shown(dir)}: could not create ${shown(component)} (${code})`;
    }
  }
  return null;
}
