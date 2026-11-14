import { realpathSync } from "node:fs";
import path from "node:path";
import { exportRelativeDir, isInsideDir, runsRelativeDir } from "./state-layout.js";

// Responsibility: whether a path that a file under the state directory
// names really stays where nukadoko wrote it, with every symlink on the
// way resolved. Every reader that follows a name it did not compute
// itself (a run.json, a step record's path, an exports manifest line)
// asks here first. The checks read the file system (realpath) but never
// change it.
//
// Why real paths and not the lexical check of state-layout.ts: a run
// directory can be copied in from another machine, and a copied
// directory can hold a symlink. `<stateDir>/export/evil/victim.txt` is
// inside `export/` by its spelling and outside it once `evil` is a
// symlink to the project root, and a removal through it deletes the
// project file. The alternative refused was refusing every symlink
// anywhere under the state directory: a project may keep its whole state
// directory on another disk through one symlink, and that resolves the
// same for the directory and for what is inside it.

/** `parent` itself, or a path inside it. Lexical. */
export function isWithin(parent: string, child: string): boolean {
  return path.resolve(parent) === path.resolve(child) || isInsideDir(parent, child);
}

/** `target` with every symlink resolved, or, when it does not exist, the
 * nearest existing parent resolved with the rest appended, so a missing
 * file behind a symlinked directory still resolves to where it would be. */
export function realTarget(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realTarget(parent), path.basename(absolute));
  }
}

/** Whether `file`, once its symlinks are resolved, stays inside `dir`'s
 * real path (or is `dir`). */
export function staysWithin(dir: string, file: string): boolean {
  return isWithin(realTarget(dir), realTarget(file));
}

/** Whether `file` may be removed as a file under `dir`: its parent
 * directories, resolved, stay strictly inside `dir`'s real path. The file
 * itself is not resolved, because removing a symlink removes the link and
 * never its target. */
export function removableWithin(dir: string, file: string): boolean {
  const absolute = path.resolve(file);
  const resolved = path.join(realTarget(path.dirname(absolute)), path.basename(absolute));
  return isInsideDir(realTarget(dir), resolved);
}

/** Whether `runDir` lies lexically under `<stateDir>/runs/` but is (or
 * passes through) a symlink there: such a directory is not one `nuka run`
 * wrote, and every containment check that takes it as its root would
 * accept wherever it points. A symlinked state directory, or `runs/`
 * itself, resolves the same for the run directory and is not one. */
export function isSymlinkedRunDir(rootDir: string, stateDir: string, runDir: string): boolean {
  const runsDir = path.resolve(rootDir, runsRelativeDir(stateDir));
  const absolute = path.resolve(runDir);
  if (!isInsideDir(runsDir, absolute)) return false;
  return realTarget(absolute) !== path.join(realTarget(runsDir), path.relative(runsDir, absolute));
}

/** `<stateDir>/export/`, the one directory an exports manifest line may
 * name a file in. */
export function exportDirOf(rootDir: string, stateDir: string): string {
  return path.resolve(rootDir, exportRelativeDir(stateDir));
}
