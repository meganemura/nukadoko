import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_CAP, STEP_FILES_CAP, windowFor } from "../src/context/kept-text.js";
import {
  changesFromTouches,
  compareScratch,
  describeChanges,
  type Identity,
  identityOf,
  mergeFileChanges,
  type PathChange,
  snapshotScratch,
} from "../src/context/step-files.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the step record's `observed.files`
// (src/context/step-files.ts). The properties: the changes the write
// patch's first-touch identities imply are exactly the paths whose
// identity moved, a path whose identity could not be read on either side
// is named apart and never a change, and merging them with the scratch
// comparison gives one sorted entry per path, the scratch side winning.
// The examples: an identity that cannot be read, a scratch directory
// compared before and after, and the content caps. The property of the
// caps: whatever the step wrote, text or binary, describing it reads at
// most the step's budget and one file's cap past it, keeps at most the
// budget as text, and opens no file once the budget is spent.

const paths = gs.sampledFrom(["/w/a", "/w/b", "/w/c", "/w/d/", "/w/e"]);
const change = gs.sampledFrom<PathChange["change"]>(["added", "changed", "removed"]);
const changes = gs
  .maps(paths, change, { maxSize: 5 })
  .map((entries) => [...entries].map(([target, each]) => ({ path: target, change: each })));
const identity = gs.sampledFrom<Identity>([null, "file:1:1:1:1", "file:2:2:2:1", "link:1:1:1:2"]);
const inspection = gs.sampledFrom<Identity | { error: string }>([null, "file:1:1:1:1", "dir", { error: "EACCES" }, { error: "ELOOP" }]);

describe("mergeFileChanges", () => {
  it("lists every path once, sorted, with the scratch comparison's change where both name it", () =>
    hegel.test((tc) => {
      const fromScratch = tc.draw(changes);
      const fromWrites = tc.draw(changes);
      const merged = mergeFileChanges(fromScratch, fromWrites);
      const names = merged.map((entry) => entry.path);
      expect(names).toEqual([...new Set([...fromScratch, ...fromWrites].map((entry) => entry.path))].sort());
      for (const entry of merged) {
        const scratch = fromScratch.find((each) => each.path === entry.path);
        expect(entry).toEqual(scratch ?? fromWrites.find((each) => each.path === entry.path));
      }
    }));
});

describe("changesFromTouches", () => {
  it("reports exactly the paths whose identity moved, as added, removed, or changed", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.maps(gs.sampledFrom(["/w/a", "/w/b", "/w/c"]), identity, { maxSize: 3 }));
      const after = new Map([...before.keys()].map((target) => [target, tc.draw(identity)]));
      const reported = changesFromTouches(before, (target) => after.get(target) ?? null);
      expect(reported.uninspected).toEqual([]);
      const expected = [...before]
        .filter(([target, was]) => after.get(target) !== was)
        .map(([target, was]) => ({
          path: target,
          change: was === null ? "added" : after.get(target) === null ? "removed" : "changed",
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      expect(reported.changes).toEqual(expected);
    }));

  it("names a path it could not inspect on either side apart, with the first error, and never as a change", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.maps(gs.sampledFrom(["/w/a", "/w/b", "/w/c"]), inspection, { maxSize: 3 }));
      const after = new Map([...before.keys()].map((target) => [target, tc.draw(inspection)]));
      const reported = changesFromTouches(before, (target) => after.get(target) ?? null);
      const errorOf = (value: Identity | { error: string } | undefined): string | undefined =>
        typeof value === "object" && value !== null ? value.error : undefined;
      const expected = [...before]
        .filter(([target, was]) => errorOf(was) !== undefined || errorOf(after.get(target)) !== undefined)
        .map(([target, was]) => ({ path: target, error: errorOf(was) ?? errorOf(after.get(target))! }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      expect(reported.uninspected).toEqual(expected);
      const unread = new Set(expected.map((entry) => entry.path));
      for (const entry of reported.changes) expect(unread.has(entry.path.replace(/\/$/, ""))).toBe(false);
    }));

  it("names a directory with a trailing separator", () => {
    expect(changesFromTouches(new Map([["/w/out", null]]), () => "dir").changes).toEqual([{ path: "/w/out/", change: "added" }]);
  });
});

describe("identityOf", () => {
  let base: string;
  beforeEach(async () => {
    base = await createEmptyTempDir();
  });
  afterEach(async () => {
    await removeTempDir(base);
  });

  it("reads a path under a file as absent, and a path it cannot resolve as the error's code", () => {
    fs.writeFileSync(path.join(base, "plain"), "x");
    expect(identityOf(path.join(base, "plain", "child"))).toBeNull();
    expect(identityOf(path.join(base, "missing"))).toBeNull();
    fs.symlinkSync(path.join(base, "b"), path.join(base, "a"));
    fs.symlinkSync(path.join(base, "a"), path.join(base, "b"));
    expect(identityOf(path.join(base, "a", "x"))).toEqual({ error: "ELOOP" });
    expect(identityOf(path.join(base, "x".repeat(300)))).toEqual({ error: "ENAMETOOLONG" });
  });
});

describe("the scratch comparison and the content caps", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("compares a scratch directory before and after, and compares one created since with nothing", async () => {
    // Siblings, as `scratch.dir()` makes them.
    const first = path.join(dir, "first");
    const later = path.join(dir, "later");
    await mkdir(first);
    await writeFile(path.join(first, "kept.txt"), "same");
    await writeFile(path.join(first, "edited.txt"), "old");
    const before = snapshotScratch([first], []);
    await writeFile(path.join(first, "edited.txt"), "longer text");
    await mkdir(path.join(later, "out"), { recursive: true });
    await writeFile(path.join(later, "out", "new.txt"), "new");
    expect(compareScratch(before, [first, later], [])).toEqual({
      changes: [
        { path: path.join(first, "edited.txt"), change: "changed" },
        { path: `${path.join(later, "out")}/`, change: "added" },
        { path: path.join(later, "out", "new.txt"), change: "added" },
      ],
      unmeasured: [],
    });
  });

  it("keeps each file's content up to its cap and to what every byte read so far left of the step's budget", async () => {
    const size = FILE_CAP + 10;
    const files = Array.from({ length: STEP_FILES_CAP / FILE_CAP + 1 }, (_, index) => path.join(dir, `f${String(index).padStart(2, "0")}.txt`));
    for (const file of files) await writeFile(file, "x".repeat(size));
    const described = describeChanges(files.map((file) => ({ path: file, change: "added" as const })), []);
    // Each of these files is read whole, so after seven the budget has
    // less than one file's cap left.
    const full = Math.floor(STEP_FILES_CAP / size);
    expect(described.slice(0, full).every((entry) => entry.content?.text?.length === FILE_CAP && entry.content.truncated === true)).toBe(true);
    expect(described[full]?.content).toEqual({ text: "x".repeat(STEP_FILES_CAP - full * size), bytes: size, truncated: true });
    expect(described.at(-1)).toEqual({ path: files.at(-1), change: "added", bytes: size, content: { text: "", bytes: size, truncated: true } });
  });

  it("counts a binary file's read against the step's budget, though it keeps no text", async () => {
    const files = Array.from({ length: 200 }, (_, index) => path.join(dir, `f${String(index).padStart(3, "0")}.bin`));
    for (const file of files) await writeFile(file, Buffer.alloc(20_000, 0xff));
    const { described, opened } = describedCounting(files);
    const read = STEP_FILES_CAP / windowFor(FILE_CAP);
    expect(opened).toEqual(files.slice(0, read));
    expect(described.slice(0, read).every((entry) => entry.content?.binary === true)).toBe(true);
    expect(described.slice(read).every((entry) => entry.bytes === 20_000 && entry.content?.text === "")).toBe(true);
  });

  it("reads at most its budget and one file's cap past it, keeps at most its budget, and opens no file once the budget is spent", () =>
    hegel.test(
      (tc) => {
        const written = tc.draw(gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: 20_000 }), gs.booleans()), { maxSize: 14 }));
        const caseDir = fs.mkdtempSync(path.join(dir, "case-"));
        const files = written.map(([size, binary], index) => {
          const file = path.join(caseDir, `f${String(index).padStart(2, "0")}`);
          fs.writeFileSync(file, Buffer.alloc(size, binary ? 0xff : 0x78));
          return file;
        });
        const { described, opened, reads } = describedCounting(files);
        const bytesRead = reads.reduce((sum, count) => sum + count, 0);
        const kept = described.reduce((sum, entry) => sum + Buffer.byteLength(entry.content?.text ?? "", "utf8"), 0);
        expect(bytesRead).toBeLessThanOrEqual(STEP_FILES_CAP + FILE_CAP);
        expect(kept).toBeLessThanOrEqual(STEP_FILES_CAP);
        // The files opened are the first ones, up to the one that spent
        // the budget: the reads before the last one stayed under it.
        expect(opened).toEqual(files.slice(0, opened.length));
        expect(reads.slice(0, -1).reduce((sum, count) => sum + count, 0)).toBeLessThan(STEP_FILES_CAP);
        if (opened.length < files.length) expect(bytesRead).toBeGreaterThanOrEqual(STEP_FILES_CAP);
      },
      { testCases: 40 },
    ));

  /** `describeChanges` over `files`, all added, with the files it opened
   * and the bytes it read from each. step-files.ts imports `openSync` and
   * `readSync` by name, so the count goes through the same export refresh
   * the channel patches use. */
  function describedCounting(files: readonly string[]): { described: ReturnType<typeof describeChanges>; opened: string[]; reads: number[] } {
    const { openSync, readSync } = fs;
    const opened: string[] = [];
    const reads: number[] = [];
    fs.openSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(target));
      reads.push(0);
      return (openSync as (...a: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync;
    fs.readSync = ((...args: unknown[]) => {
      const count = (readSync as (...a: unknown[]) => number)(...args);
      reads[reads.length - 1]! += count;
      return count;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      return { described: describeChanges(files.map((file) => ({ path: file, change: "added" as const })), []), opened, reads };
    } finally {
      fs.openSync = openSync;
      fs.readSync = readSync;
      syncBuiltinESMExports();
    }
  }

  it("opens no file once the step's budget is spent, and takes the size of the rest from lstat", async () => {
    const kept = STEP_FILES_CAP / FILE_CAP;
    const files = Array.from({ length: kept + 20 }, (_, index) => path.join(dir, `f${String(index).padStart(2, "0")}.txt`));
    for (const [index, file] of files.entries()) await writeFile(file, "x".repeat(FILE_CAP + index));
    // step-files.ts imports openSync by name, so the count goes through
    // the same export refresh the channel patches use.
    const original = fs.openSync;
    const opened: string[] = [];
    fs.openSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(target));
      return (original as (...a: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    let described: ReturnType<typeof describeChanges>;
    try {
      described = describeChanges(files.map((file) => ({ path: file, change: "added" as const })), []);
    } finally {
      fs.openSync = original;
      syncBuiltinESMExports();
    }
    expect(opened).toEqual(files.slice(0, kept));
    expect(described.slice(kept).map((entry) => entry.bytes)).toEqual(files.slice(kept).map((_, index) => FILE_CAP + kept + index));
  });

  it("keeps no content for a removed path or a directory", () => {
    expect(describeChanges([{ path: path.join(dir, "gone.txt"), change: "removed" }, { path: `${dir}/`, change: "changed" }], [])).toEqual([
      { path: path.join(dir, "gone.txt"), change: "removed" },
      { path: `${dir}/`, change: "changed" },
    ]);
  });
});
