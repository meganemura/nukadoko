import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObservedCollector } from "../src/context/observed.js";
import { diffSnapshots, type Snapshot } from "../src/context/file-snapshot.js";
import { runCommand, withProcessRecording } from "../src/context/run-command.js";

// Responsibility: the file channel of `observed.processes[].files`: the
// difference between two snapshots as a pure function, and what
// `runCommand` records for a program that adds, rewrites, or removes a
// file in its working directory.

const node = process.execPath;

function measured(entries: Iterable<[string, string]>): Snapshot {
  return { kind: "measured", entries: new Map(entries), skipped: [] };
}

// Pairs, folded into one record so a path appears at most once.
const entryMap = gs
  .arrays(
    gs.tuples(
      gs.sampledFrom(["a", "b", "c/", "c/d", "e", "f/", "f/g"]),
      gs.sampledFrom(["dir", "1:1:1:1", "2:2:2:2", "3:3:3:3"]),
    ),
    { maxSize: 7 },
  )
  .map((pairs) => Object.fromEntries(pairs) as Record<string, string>);

describe("diffSnapshots", () => {
  it("finds nothing between a snapshot and itself", () =>
    hegel.test((tc) => {
      const entries = tc.draw(entryMap);
      const snapshot = measured(Object.entries(entries));
      expect(diffSnapshots(snapshot, snapshot)).toEqual({ added: [], changed: [], removed: [] });
    }));

  it("swaps added and removed, and keeps changed, when the order is reversed", () =>
    hegel.test((tc) => {
      const before = measured(Object.entries(tc.draw(entryMap)));
      const after = measured(Object.entries(tc.draw(entryMap)));
      const forward = diffSnapshots(before, after);
      const backward = diffSnapshots(after, before);
      if ("unmeasured" in forward || "unmeasured" in backward) throw new Error("both sides were measured");
      expect(backward.added).toEqual(forward.removed);
      expect(backward.removed).toEqual(forward.added);
      expect(backward.changed).toEqual(forward.changed);
    }));

  it("names each path that differs exactly once", () =>
    hegel.test((tc) => {
      const before = tc.draw(entryMap);
      const after = tc.draw(entryMap);
      const diff = diffSnapshots(measured(Object.entries(before)), measured(Object.entries(after)));
      if ("unmeasured" in diff) throw new Error("both sides were measured");
      const named = [...diff.added, ...diff.changed, ...diff.removed].sort();
      const differing = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => before[key] !== after[key])
        .sort();
      expect(named).toEqual(differing);
    }));

  it("is unmeasured when either side is", () => {
    const unmeasured: Snapshot = { kind: "unmeasured", reason: "too big" };
    expect(diffSnapshots(unmeasured, measured([]))).toEqual({ unmeasured: "too big" });
    expect(diffSnapshots(measured([]), unmeasured)).toEqual({ unmeasured: "too big" });
  });
});

describe("runCommand's files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nukadoko-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function filesOf(script: string, unwatchedDirs: readonly string[] = []): Promise<unknown> {
    const observed = createObservedCollector({ unwatchedDirs });
    await withProcessRecording(observed, () => runCommand(node, ["-e", script], { cwd: dir }));
    return observed.snapshot().processes![0]!.files;
  }

  it("records an added, a rewritten, and a removed file", async () => {
    await writeFile(path.join(dir, "kept.txt"), "same");
    await writeFile(path.join(dir, "rewritten.txt"), "old");
    await writeFile(path.join(dir, "gone.txt"), "bye");
    const files = await filesOf(
      [
        "const fs = require('node:fs');",
        "fs.mkdirSync('out');",
        "fs.writeFileSync('out/new.txt', 'new');",
        "fs.writeFileSync('rewritten.txt', 'longer text');",
        "fs.rmSync('gone.txt');",
      ].join(" "),
    );
    expect(files).toEqual({ added: ["out/", "out/new.txt"], changed: ["rewritten.txt"], removed: ["gone.txt"] });
  });

  it("records no change for a program that only reads", async () => {
    await writeFile(path.join(dir, "data.txt"), "data");
    expect(await filesOf("require('node:fs').readFileSync('data.txt')")).toEqual({ added: [], changed: [], removed: [] });
  });

  it("skips an unwatched directory and names it", async () => {
    await mkdir(path.join(dir, "state"));
    const files = await filesOf("require('node:fs').writeFileSync('state/record.json', '{}')", [path.join(dir, "state")]);
    expect(files).toEqual({ added: [], changed: [], removed: [], skipped: ["state/"] });
  });

  it("returns the files it recorded to the step", async () => {
    const observed = createObservedCollector();
    const result = await withProcessRecording(observed, () =>
      runCommand(node, ["-e", "require('node:fs').writeFileSync('made.txt', '')"], { cwd: dir }),
    );
    expect(result.files).toEqual({ added: ["made.txt"], changed: [], removed: [] });
    expect(result.files).toEqual(observed.snapshot().processes![0]!.files);
  });

  it("measures files outside a step only when asked", async () => {
    const script = "require('node:fs').writeFileSync('made.txt', String(Date.now()))";
    expect((await runCommand(node, ["-e", script], { cwd: dir })).files).toBeUndefined();
    expect((await runCommand(node, ["-e", script], { cwd: dir, files: true })).files).toEqual({ added: [], changed: ["made.txt"], removed: [] });
  });

  it("records nothing about files outside a step", async () => {
    const observed = createObservedCollector();
    await runCommand(node, ["-e", "require('node:fs').writeFileSync('x', '')"], { cwd: dir });
    expect(observed.snapshot().processes).toBeNull();
  });
});
