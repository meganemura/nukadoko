import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ScenarioRecord } from "../record/scenario-record.js";

// Responsibility: measure the commit, the working-tree cleanliness, and
// the working tree's id a `nuka run` invocation started at, and the id
// `nuka verdict` compares it with. Each is probed once per run
// (cli/run.ts), never once per pickle: a step that edits a
// tracked file mid-run must not change what every scenario record from that
// same run reports as its own starting point.
//
// One git call, not two: what costs
// time here isn't the git command itself (`status --porcelain` is 10-20ms
// standalone) but the child-process fork+exec, which contends when vitest's
// parallel workers all do it at once. `git status --porcelain=v2 --branch`
// reports the commit (a `# branch.oid ...` header line) and the working-tree
// state (any non-`#`-prefixed line) in one invocation, so `rev-parse` is no
// longer needed at all. `--porcelain=v2` is used deliberately, still never
// `-uno`: an untracked step file is exactly
// what src/discover/discover-steps.ts would have loaded into this same run,
// so it belongs in the same cleanliness check the run summary reports —
// v2's header lines are always `#`-prefixed, so untracked (`?`) and changed
// (`1`/`2`/`u`) lines are told apart from headers by that prefix alone, no
// `-uno` needed to keep headers separate from content.
//
// Before the first commit (`git init` with nothing committed yet), `git
// status --porcelain=v2 --branch` reports `# branch.oid (initial)` — no sha
// exists, so this whole function returns `undefined`, the same as outside a
// repository entirely, never a `git` field with `commit: "(initial)"` in
// it: "commit X was green" can't be asserted about a commit that doesn't
// exist. A detached HEAD reports `# branch.head (detached)` but
// `branch.oid` is still a real sha, so that case is read the same as any
// other.
//
// Follows src/secrets/classify-env-files.ts's existing `execFile`/
// `promisify` pattern for calling git, including its fail-safe
// stance: no git binary on PATH, `rootDir` outside a repository, or any
// other failure collapses to `undefined` — the field is entirely absent
// from the record, the same convention `target_version`'s own probe already
// uses (src/environment/probe-version.ts) — never a reason `nuka run`
// itself fails, and (matching classify-env-files.ts) never worth a stderr
// warning either: it is one of two ordinary outcomes, not a
// misconfiguration.

const execFileAsync = promisify(execFile);

/** `ScenarioRecord.git`'s own shape, unwrapped from its `| undefined`. */
export type GitState = NonNullable<ScenarioRecord["git"]>;

export async function probeGitState(rootDir: string): Promise<GitState | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootDir, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
      { encoding: "utf8" },
    );

    let commit: string | undefined;
    let clean = true;
    for (const line of stdout.split("\n")) {
      if (line.length === 0) continue;
      if (line.startsWith("# branch.oid ")) {
        const oid = line.slice("# branch.oid ".length).trim();
        commit = oid === "(initial)" ? undefined : oid;
      } else if (!line.startsWith("#")) {
        clean = false;
      }
    }

    return commit === undefined ? undefined : { commit, clean };
  } catch {
    return undefined;
  }
}

// The working tree as one git tree id: every tracked file as it is on disk
// and every untracked file `.gitignore` does not leave out, with the state
// directory left out too, since every run writes there and a run would
// otherwise move the tree it judged. Two runs that recorded the same id
// judged the same bytes at the same paths, which `dirty: true` cannot say:
// it is true for every uncommitted edit alike. On a clean tree the id is
// `HEAD^{tree}`, so a commit made after a run does not change it.
//
// It never touches the real index and writes no file's contents. The
// scratch index is a copy of the real one in a temporary directory, so the
// real index is never staged into or locked, and the copy keeps its stat
// cache: only the files that changed since the last `git add` are hashed.
// The copy also keeps the real index's modification time, rounded down to
// the second (see `copyIndex`), or that cache would lie about a file
// edited in the same second the real index was written.
// `--info-only` records each changed file's id without writing its blob to
// the object database, and `write-tree --missing-ok` accepts the ids it
// has no blob for; `git add -A` on the copy would give the same id but
// leave a blob behind for every changed file, on every run, until `git
// gc`. What write-tree does store is the tree objects of the directories
// that changed, a few hundred bytes each, which no ref reaches and `git
// gc` removes; write-tree is the one command that turns an index into a tree id. It also refuses an
// untracked repository nested inside, which this way is left out with a
// line on git's stderr. A submodule counts as the commit it has checked out.
//
// `undefined` outside a repository, before the first commit (the same
// convention as `probeGitState`: there is no HEAD to compare a clean tree
// with), and when any git call fails; a run never fails over it.
export async function probeWorkingTree(rootDir: string, stateDir: string): Promise<string | undefined> {
  let scratch: string | undefined;
  try {
    const located = await gitOutput(["-C", rootDir, "rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "index", "HEAD"], process.env);
    const [toplevel, prefix, indexPath] = located.split("\n");
    if (toplevel === undefined || prefix === undefined || indexPath === undefined) return undefined;
    scratch = await mkdtemp(path.join(tmpdir(), "nukadoko-working-tree-"));
    const scratchIndex = path.join(scratch, "index");
    const realIndex = path.resolve(rootDir, indexPath);
    if (existsSync(realIndex)) await copyIndex(realIndex, scratchIndex);
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    const changed = await gitOutput(
      ["-C", toplevel, "ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard", "--", ".", ...stateDirExclusion(rootDir, prefix, stateDir)],
      env,
    );
    if (changed.length > 0) {
      await gitOutput(["-C", toplevel, "update-index", "-z", "--add", "--remove", "--info-only", "--no-split-index", "--stdin"], env, changed);
    }
    return (await gitOutput(["-C", toplevel, "write-tree", "--missing-ok"], env)).trim();
  } catch {
    return undefined;
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

// git trusts an entry's stat data (size, mtime, ctime, inode) only when the
// file's mtime is older than the index file's own mtime. An entry whose
// file has an mtime at or after the index's is "racily clean": the file may
// have been rewritten after git looked at it, in the same timestamp tick,
// at the same size, so git compares its contents instead. A plain copy gets
// a new mtime, later than every entry, so a same-size edit made in the same
// second the real index was written went unlisted by `ls-files --modified`
// and the id was the old file's. git builds without nanosecond stat
// comparison (the Linux git 2.43 measured here among them) match an entry
// on the second alone, so this happened about once in three hundred
// measured edits made right after a commit.
//
// Setting the copy's mtime back to the real one restores git's own check.
// Whole seconds, rounded down, rather than the exact time: utimes takes a
// double, which cannot hold a current time to the nanosecond, and rounding
// up would trust an entry the real index did not. An earlier index mtime
// only makes more entries racily clean, so the rounding can cost a content
// comparison for a file touched in that second and never a missed edit. The
// stat and the contents come from one open file, so a `git add` that
// replaces the index meanwhile cannot pair one index's bytes with another's
// mtime.
async function copyIndex(realIndex: string, scratchIndex: string): Promise<void> {
  const handle = await open(realIndex, "r");
  try {
    const { mtimeNs } = await handle.stat({ bigint: true });
    await writeFile(scratchIndex, await handle.readFile());
    const seconds = Number(mtimeNs / 1_000_000_000n);
    await utimes(scratchIndex, seconds, seconds);
  } finally {
    await handle.close();
  }
}

/** The pathspec that leaves the state directory out, relative to the
 * repository's top; none when the state directory is outside the
 * repository, where git would refuse the pathspec. */
function stateDirExclusion(rootDir: string, prefix: string, stateDir: string): string[] {
  const fromRoot = path.relative(rootDir, path.resolve(rootDir, stateDir));
  if (fromRoot === "" || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return [];
  return [`:(exclude)${path.posix.join(prefix, fromRoot.split(path.sep).join("/"))}`];
}

// ls-files lists every untracked file by name, so its output grows with
// the tree; execFile's 1 MiB default would fail a large one.
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

function gitOutput(args: readonly string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { encoding: "utf8", env, maxBuffer: GIT_OUTPUT_LIMIT }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (input === undefined) return;
    // A git that exits before reading all of its input closes the pipe; the
    // exit code already says why, so the write error is not a second one.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
