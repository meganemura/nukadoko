import { realpathSync, statSync, type Dirent } from "node:fs";

// Responsibility: what the three project walks (features, step files, oath
// Markdown) see in one directory entry once a symbolic link is followed,
// and whether a directory was already entered. A monorepo links shared
// steps and features into featuresDir, and a walk that took `Dirent` at
// its word skipped every link with no report. Nothing here filters by name
// or extension; each walk keeps its own rules for that.

export type EntryKind = "directory" | "file" | "other";

/** A link is followed. A link whose target is missing reads as a file, so
 * the walk passes it on to the import or the read, and that failure names
 * the path instead of the link vanishing. */
export function entryKind(fullPath: string, entry: Dirent): EntryKind {
  if (!entry.isSymbolicLink()) {
    return entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
  }
  try {
    const stat = statSync(fullPath);
    return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  } catch {
    return "file";
  }
}

/** True the first time a walk reaches a directory by any path. A link that
 * points back up the tree, or two links to one directory, would otherwise
 * loop forever or list the same files twice. */
export function enterOnce(dir: string, entered: Set<string>): boolean {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return true;
  }
  if (entered.has(real)) {
    return false;
  }
  entered.add(real);
  return true;
}
