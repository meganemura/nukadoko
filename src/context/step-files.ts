import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { FileChange, UnmeasuredEntry } from "../record/types.js";
import type { SecretSet } from "../secrets/types.js";
import { diffSnapshots, type Snapshot, takeSnapshot } from "./file-snapshot.js";
import { FILE_CAP, keepText, STEP_FILES_CAP, windowFor } from "./kept-text.js";

// Responsibility: the step record's `observed.files` (docs/spec.md
// "Records"): which paths one step changed, from two sources, and what
// each changed file holds afterwards.
//
// The two sources see different things. The scratch directories are
// compared before and after the step (file-snapshot.ts), which sees a
// write from any process, a `runCommand` child included, but only inside
// those directories. The `node:fs` patch (channels.ts) sees every write
// the step's own process made anywhere, but nothing a child process did.
// Together they cover what a step usually writes without walking the
// project root, which would cost more than most steps take and would
// read every write of a dev server in the same tree as the step's.
//
// A path from the patch counts as changed only when its identity (size,
// times, inode, as file-snapshot.ts reads them) differs between the first
// write call and the end of the step, so a write call that failed, or a
// `mkdir` of a directory that already existed, is not reported. A path
// created and removed within the step is not reported either: nothing
// changed on disk.
//
// Contents are read once, after the step, so a file written in several
// calls is kept as it ended up. Each file keeps at most FILE_CAP bytes of
// text and the step at most STEP_FILES_CAP, so a step that writes a
// thousand files cannot make its record the largest file of the run.

export type Change = FileChange["change"];

/** A path and how it changed. A directory's path ends in `/`. */
export interface PathChange {
  readonly path: string;
  readonly change: Change;
}

/** What a path was at one moment: `null` when absent, `"dir"` for a
 * directory, otherwise its kind and stat. */
export type Identity = string | null;

export function identityOf(target: string): Identity {
  const info = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (info === undefined) return null;
  if (info.isDirectory()) return "dir";
  const kind = info.isSymbolicLink() ? "link" : "file";
  return `${kind}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
}

/** `target` with exactly one trailing `/`, the way a directory is named. */
export function asDirectory(target: string): string {
  return `${target.replace(/[\\/]+$/, "")}/`;
}

/** The changes the patch's first-touch identities imply, given each
 * path's identity now. Sorted by path. */
export function changesFromTouches(
  touched: ReadonlyMap<string, Identity>,
  now: (target: string) => Identity,
): PathChange[] {
  const changes: PathChange[] = [];
  for (const [target, before] of touched) {
    const after = now(target);
    if (before === after) continue;
    const change: Change = before === null ? "added" : after === null ? "removed" : "changed";
    const isDirectory = before === "dir" || after === "dir";
    changes.push({ path: isDirectory ? asDirectory(target) : target, change });
  }
  return changes.sort(byPath);
}

/** Both sources as one list, one entry per path, sorted by path. Where
 * both name a path, the scratch comparison wins: it compares the path's
 * whole state before and after, where the patch saw only the calls this
 * process made. */
export function mergeFileChanges(fromScratch: readonly PathChange[], fromWrites: readonly PathChange[]): PathChange[] {
  const merged = new Map<string, PathChange>();
  for (const entry of fromWrites) merged.set(entry.path, entry);
  for (const entry of fromScratch) merged.set(entry.path, entry);
  return [...merged.values()].sort(byPath);
}

function byPath(a: PathChange, b: PathChange): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Each scratch directory's state at the start of a step. */
export type ScratchState = ReadonlyMap<string, Snapshot>;

export function snapshotScratch(dirs: readonly string[], unwatched: readonly string[]): ScratchState {
  return new Map(dirs.map((dir) => [dir, takeSnapshot(dir, unwatched)]));
}

const EMPTY: Snapshot = { kind: "measured", entries: new Map(), skipped: [] };

/** What changed in each scratch directory since `before`. A directory
 * created during the step is compared with an empty one, so everything
 * in it is added. A directory that could not be walked is an unmeasured
 * entry instead. */
export function compareScratch(
  before: ScratchState,
  dirs: readonly string[],
  unwatched: readonly string[],
): { readonly changes: PathChange[]; readonly unmeasured: UnmeasuredEntry[] } {
  const changes: PathChange[] = [];
  const unmeasured: UnmeasuredEntry[] = [];
  for (const dir of dirs) {
    const difference = diffSnapshots(before.get(dir) ?? EMPTY, takeSnapshot(dir, unwatched));
    if ("unmeasured" in difference) {
      unmeasured.push({ kind: "files", detail: `scratch directory ${dir}: ${difference.unmeasured}` });
      continue;
    }
    for (const change of ["added", "changed", "removed"] as const) {
      for (const relative of difference[change]) {
        const absolute = path.join(dir, relative);
        changes.push({ path: relative.endsWith("/") ? asDirectory(absolute) : absolute, change });
      }
    }
  }
  return { changes: changes.sort(byPath), unmeasured };
}

/** The record's entries for `changes`: each file's size and content
 * after the step, within the caps. Once the step's budget is spent, a
 * file is no longer opened: its size comes from `lstat`, so a step that
 * wrote a thousand files costs a thousand stats, not a thousand reads. */
export function describeChanges(changes: readonly PathChange[], secrets: SecretSet): FileChange[] {
  let budget = STEP_FILES_CAP;
  return changes.map((entry) => {
    if (entry.change === "removed" || entry.path.endsWith("/")) return { path: entry.path, change: entry.change };
    const info = lstatSync(entry.path, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) return { path: entry.path, change: entry.change };
    if (budget <= 0) {
      return { path: entry.path, change: entry.change, bytes: info.size, content: { text: "", bytes: info.size, truncated: true } };
    }
    const read = readStart(entry.path, Math.min(windowFor(FILE_CAP), info.size));
    if (read === undefined) return { path: entry.path, change: entry.change };
    const kept = keepText(read, read.length >= info.size, Math.min(FILE_CAP, budget), secrets);
    if ("text" in kept) budget -= Buffer.byteLength(kept.text, "utf8");
    return { path: entry.path, change: entry.change, bytes: info.size, content: { ...kept, bytes: info.size } };
  });
}

/** The first `size` bytes of a file, or `undefined` for a file that
 * went away or could not be read. */
function readStart(target: string, size: number): Uint8Array | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(target, "r");
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    return buffer.subarray(0, filled);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
