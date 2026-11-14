import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProcessFiles } from "../record/types.js";

// Responsibility: what changed on disk under a process's working directory
// while `runCommand` ran it: one snapshot before the spawn, one after the
// close, and the difference between them (docs/spec.md "Records",
// `observed.processes[].files`).
// Boundary: it measures a directory, not a process. A write to the same
// directory from anything else running at the same time is in the
// difference too, which is why the record names the directory and not the
// process as the writer. It never reads a file's content.
//
// A file counts as changed when its size, its modification time, its
// change time, or its inode differs, read with nanosecond times. That is
// exact for "was this file written": rewriting a file with the same bytes
// is still a write and still shows. Hashing content would miss nothing
// more and would read every byte of every file twice per process.
//
// `node_modules` and `.git` directories are not walked: a project's own
// install holds tens of thousands of files, so walking it twice for every
// process would cost more than most steps take. They are named in
// `skipped` when present, so a write there is a known blind spot rather
// than a silent one. A tree past MAX_ENTRIES entries is not measured at
// all, and the record says so, for the same reason.
//
// The executor also names directories it writes to itself while a step
// runs (the state directory, where step records and traces land), so its
// own writes are not read as the program's. They are skipped the same way
// and named in `skipped` too.

const SKIPPED_NAMES = new Set(["node_modules", ".git"]);
export const MAX_ENTRIES = 20000;

/** A directory's entries by relative path. A directory's own identity
 * is only that it is present, because its times move whenever a child
 * changes; anything else carries its stat. */
export type Snapshot =
  | { readonly kind: "measured"; readonly entries: ReadonlyMap<string, string>; readonly skipped: readonly string[] }
  | { readonly kind: "unmeasured"; readonly reason: string };

/** Walks `root` without following symbolic links. Paths are relative to
 * `root`, with `/` separators on every platform, and a directory's path
 * ends in `/`. A directory whose absolute path is in `unwatched` is not
 * walked and is named in `skipped`.
 *
 * Synchronous on purpose: awaiting each stat took about 0.25 s over the
 * 3000 entries of a small repository, and the same walk with the
 * synchronous calls took about 20 ms, twice per process. */
export function takeSnapshot(root: string, unwatched: readonly string[] = []): Snapshot {
  const unwatchedPaths = new Set(unwatched.map((dir) => resolve(dir)));
  const entries = new Map<string, string>();
  const skipped: string[] = [];
  const pending: string[] = [""];
  try {
    while (pending.length > 0) {
      const relativeDir = pending.pop()!;
      const names = listed(root, relativeDir);
      if (names === null) {
        entries.delete(relativeDir);
        continue;
      }
      for (const name of names) {
        const relative = relativeDir === "" ? name : `${relativeDir}${name}`;
        // Absent when it was removed between the listing and the stat.
        const info = lstatSync(join(root, relative), { bigint: true, throwIfNoEntry: false });
        if (info === undefined) continue;
        if (info.isDirectory()) {
          if (SKIPPED_NAMES.has(name) || unwatchedPaths.has(resolve(root, relative))) {
            skipped.push(`${relative}/`);
            continue;
          }
          entries.set(`${relative}/`, "dir");
          pending.push(`${relative}/`);
        } else {
          entries.set(relative, `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`);
        }
        if (entries.size > MAX_ENTRIES) {
          return { kind: "unmeasured", reason: `more than ${MAX_ENTRIES} entries under the working directory` };
        }
      }
    }
  } catch (error) {
    return { kind: "unmeasured", reason: `the working directory could not be read: ${(error as Error).message}` };
  }
  return { kind: "measured", entries, skipped: skipped.sort() };
}

/** The names in a directory the walk reached, or `null` for one below
 * `root` that was removed, or replaced by a file, after its parent listed
 * it: it is absent at the moment the walk reads it, as a file removed
 * between the listing and the stat is. Anything else, and a `root` that
 * cannot be read, still leaves the whole walk unmeasured. */
function listed(root: string, relativeDir: string): string[] | null {
  try {
    return readdirSync(join(root, relativeDir));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (relativeDir !== "" && (code === "ENOENT" || code === "ENOTDIR")) return null;
    throw error;
  }
}

/** The difference between two snapshots of one directory, each list
 * sorted. Unmeasured when either side was; `skipped` is the union of both
 * sides, present only when it is not empty. */
export function diffSnapshots(before: Snapshot, after: Snapshot): ProcessFiles {
  if (before.kind === "unmeasured") return { unmeasured: before.reason };
  if (after.kind === "unmeasured") return { unmeasured: after.reason };
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, identity] of after.entries) {
    const earlier = before.entries.get(path);
    if (earlier === undefined) added.push(path);
    else if (earlier !== identity) changed.push(path);
  }
  for (const path of before.entries.keys()) if (!after.entries.has(path)) removed.push(path);
  const skipped = [...new Set([...before.skipped, ...after.skipped])].sort();
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
