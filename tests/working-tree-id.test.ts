import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { probeWorkingTree } from "../src/run/probe-git.js";
import { createEmptyTempDir, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the working tree id run.json's `commit.working_tree`
// records and `nuka verdict` compares, against a real repository: it is the
// commit's own tree on a clean tree, any edit git counts moves it, an edit
// git leaves out does not, and measuring it changes nothing in the
// repository.

const execFileAsync = promisify(execFile);
const STATE_DIR = ".nukadoko";

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: dir, encoding: "utf8" })).stdout.trim();
}

/** A committed repository with two tracked files, one ignored pattern,
 * and the state directory, which a project's .gitignore need not name. */
async function repository(): Promise<string> {
  const dir = await createEmptyTempDir();
  await writeFile(path.join(dir, ".gitignore"), "*.log\n");
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.txt"), "a\n");
  await writeFile(path.join(dir, "b.txt"), "b\n");
  await initGitRepo(dir);
  return dir;
}

// One fixed second, well in the past, that a racy repository pins the
// tracked files' and the index's modification times to.
const RACY_SECOND = 1_700_000_000;
const TRACKED = ["src/a.txt", "b.txt"] as const;

/** The repository as git leaves it when a file is edited in the same second
 * its index was written: every tracked file and the index carry one mtime,
 * so git can trust no entry's stat data and must compare contents. Pinning
 * the times makes that second happen on every run instead of by chance;
 * `core.trustctime` off stands in for the ctime, which no call can set. */
async function makeRacy(dir: string): Promise<void> {
  await git(dir, "config", "core.trustctime", "false");
  for (const file of TRACKED) await utimes(path.join(dir, file), RACY_SECOND, RACY_SECOND);
  // Re-adding records the pinned mtimes in the index entries.
  await git(dir, "add", "-A");
  await utimes(path.join(dir, ".git", "index"), RACY_SECOND, RACY_SECOND);
}

/** Every loose object id in the repository. */
async function objectIds(dir: string): Promise<Set<string>> {
  const objects = path.join(await git(dir, "rev-parse", "--absolute-git-dir"), "objects");
  const fanout = (await readdir(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name));
  const ids = new Set<string>();
  for (const name of fanout) for (const rest of await readdir(path.join(objects, name))) ids.add(name + rest);
  return ids;
}

type Edit =
  | { kind: "tracked"; file: "src/a.txt" | "b.txt"; text: string }
  | { kind: "delete"; file: "src/a.txt" | "b.txt" }
  | { kind: "untracked"; name: string; text: string };
type Unseen = { kind: "ignored"; name: string; text: string } | { kind: "state"; name: string; text: string };

const NAME = gs.text({ minSize: 1, maxSize: 8, alphabet: "abcdefghij_-" });
const TEXT = gs.text({ maxSize: 20 });
const FILE = gs.sampledFrom(TRACKED);
// Half the tracked edits keep the file's two bytes, so only its contents,
// not its size, tell git it changed.
const TRACKED_TEXT = gs.oneOf(TEXT, gs.text({ minSize: 1, maxSize: 1, alphabet: "abcdefghij" }));
const edit: gs.Generator<Edit> = gs.oneOf(
  gs.tuples(FILE, TRACKED_TEXT).map(([file, text]): Edit => ({ kind: "tracked", file, text: `${text}!` })),
  FILE.map((file): Edit => ({ kind: "delete", file })),
  gs.tuples(NAME, TEXT).map(([name, text]): Edit => ({ kind: "untracked", name: `new-${name}.txt`, text })),
);
const unseen: gs.Generator<Unseen> = gs.oneOf(
  gs.tuples(NAME, TEXT).map(([name, text]): Unseen => ({ kind: "ignored", name: `${name}.log`, text })),
  gs.tuples(NAME, TEXT).map(([name, text]): Unseen => ({ kind: "state", name, text })),
);

async function apply(dir: string, change: Edit | Unseen, racy = false): Promise<void> {
  switch (change.kind) {
    case "tracked":
      // `!` after the drawn text: an edit always differs from "a\n" and "b\n".
      await writeFile(path.join(dir, change.file), change.text);
      if (racy) await utimes(path.join(dir, change.file), RACY_SECOND, RACY_SECOND);
      return;
    case "delete":
      return rm(path.join(dir, change.file), { force: true });
    case "untracked":
    case "ignored":
      return writeFile(path.join(dir, change.name), change.text);
    case "state":
      await mkdir(path.join(dir, STATE_DIR, "runs"), { recursive: true });
      return writeFile(path.join(dir, STATE_DIR, "runs", change.name), change.text);
  }
}

describe("probeWorkingTree", () => {
  it("is HEAD^{tree} on a clean tree, moves on any edit git counts, and ignores what git leaves out", async () => {
    await hegel.testAsync(
      async (tc) => {
        const before = tc.draw(gs.arrays(unseen, { maxSize: 2 }));
        const change = tc.draw(edit);
        const after = tc.draw(gs.arrays(unseen, { maxSize: 2 }));
        const dir = await repository();
        try {
          for (const item of before) await apply(dir, item);
          const clean = await probeWorkingTree(dir, STATE_DIR);
          expect(clean).toBe(await git(dir, "rev-parse", "HEAD^{tree}"));

          await apply(dir, change);
          const edited = await probeWorkingTree(dir, STATE_DIR);
          expect(edited).toMatch(/^[0-9a-f]{40}$/);
          expect(edited).not.toBe(clean);

          for (const item of after) await apply(dir, item);
          expect(await probeWorkingTree(dir, STATE_DIR)).toBe(edited);
        } finally {
          await removeTempDir(dir);
        }
      },
      { testCases: 15 },
    );
  });

  it("is the id git would give the tree with every change staged, staged changes included", async () => {
    await hegel.testAsync(
      async (tc) => {
        const changes = tc.draw(gs.arrays(edit, { minSize: 1, maxSize: 3 }));
        const staged = tc.draw(gs.booleans());
        // Racy: every edit lands in the second the index was written, which
        // a test run otherwise reaches only now and then.
        const racy = tc.draw(gs.booleans());
        const dir = await repository();
        try {
          if (racy) await makeRacy(dir);
          for (const change of changes) await apply(dir, change, racy);
          // A change already in the index and a change only on disk are
          // the same tree; the probe must not read the index's version.
          if (staged) await git(dir, "add", "-A");
          const probed = await probeWorkingTree(dir, STATE_DIR);
          await git(dir, "add", "-A");
          expect(probed).toBe(await git(dir, "write-tree"));
        } finally {
          await removeTempDir(dir);
        }
      },
      { testCases: 20 },
    );
  });

  it("sees a same-size edit made in the second the index was written", async () => {
    const dir = await repository();
    try {
      await makeRacy(dir);
      // "b\n" and "x\n": the same size, so only the contents tell them apart.
      await writeFile(path.join(dir, "b.txt"), "x\n");
      await utimes(path.join(dir, "b.txt"), RACY_SECOND, RACY_SECOND);
      const probed = await probeWorkingTree(dir, STATE_DIR);
      expect(probed).not.toBe(await git(dir, "rev-parse", "HEAD^{tree}"));
      await git(dir, "add", "-A");
      expect(probed).toBe(await git(dir, "write-tree"));
    } finally {
      await removeTempDir(dir);
    }
  });

  it("leaves the index as it was, and writes no file's contents, only the trees", async () => {
    const dir = await repository();
    try {
      await writeFile(path.join(dir, "b.txt"), "changed\n");
      await writeFile(path.join(dir, "untracked.txt"), "new\n");
      const indexFile = path.join(dir, ".git", "index");
      const index = await readFile(indexFile);
      const objects = await objectIds(dir);
      const probed = await probeWorkingTree(dir, STATE_DIR);
      expect(probed).toMatch(/^[0-9a-f]{40}$/);
      expect(await readFile(indexFile)).toEqual(index);
      const added = [...(await objectIds(dir))].filter((id) => !objects.has(id));
      expect(added).toEqual([probed]);
      for (const id of added) expect(await git(dir, "cat-file", "-t", id)).toBe("tree");
      // Nothing staged: the change is still only in the working tree.
      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      expect(status).toBe(" M b.txt\n?? untracked.txt\n");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("has no id before the first commit, or outside a repository", async () => {
    const dir = await createEmptyTempDir();
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    // The temp directory sits inside this repository's own working tree,
    // so git would find this repository without a ceiling above it.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      expect(await probeWorkingTree(dir, STATE_DIR)).toBeUndefined();
      await git(dir, "init", "-q");
      await writeFile(path.join(dir, "a.txt"), "a\n");
      expect(await probeWorkingTree(dir, STATE_DIR)).toBeUndefined();
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      await removeTempDir(dir);
    }
  });
});
