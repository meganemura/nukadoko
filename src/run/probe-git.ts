import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ScenarioRecord } from "./record-types.js";

// Responsibility: measure the commit and working-tree cleanliness a `nuka
// run` invocation started at, and the dirty paths themselves for
// `nuka accept`'s own dirty-tree refusal. `probeGitState` is called once per
// run (cli/run.ts), never once per pickle: a step that edits a
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
// so it belongs in the same cleanliness check a later sign-off will demand —
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
      ["-C", rootDir, "status", "--porcelain=v2", "--branch"],
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

// A second, separate call, not a
// change to `probeGitState` above: that function's own one-call rationale
// is about the hot path (`nuka run`, once per invocation); this one only
// runs from `nuka accept`'s dirty-tree refusal, an error path taken at most
// once per rejected `accept`. Adding paths to `GitState` instead would leak
// into every stored `ScenarioRecord.git` (src/run/record-types.ts), which
// has no use for them.
//
// Porcelain output (v1 or v2, with or without `-C`) is always relative to
// the repository root, never to the directory `git` was invoked from or
// pointed at with `-C` -- verified empirically, not assumed. `rootDir` is
// not guaranteed to be that root (a project can live in a subdirectory of a
// larger repository), so paths are rebased onto `rootDir` here before
// being handed back; skipping that step would make a stateDir string match
// paths it was never actually under, or miss ones it was.
export async function listDirtyPaths(rootDir: string): Promise<string[]> {
  try {
    const [{ stdout: topLevelOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", rootDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }),
      execFileAsync("git", ["-C", rootDir, "status", "--porcelain=v1", "-z"], { encoding: "utf8" }),
    ]);
    const repoRoot = topLevelOut.trim();

    const tokens = statusOut.split("\0").filter((token) => token.length > 0);
    const repoRelativePaths: string[] = [];
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) {
        // The path a rename/copy moved from (git-scm.com/docs/git-status:
        // "R"/"C" entries emit the new path, then the original path, as two
        // separate NUL-terminated fields). A refusal message only needs to
        // say where the tree currently differs, not where from.
        skipNext = false;
        continue;
      }
      const statusCode = token.slice(0, 2);
      repoRelativePaths.push(token.slice(3));
      if (statusCode[0] === "R" || statusCode[0] === "C") {
        skipNext = true;
      }
    }

    return repoRelativePaths.map((repoRelativePath) =>
      path.relative(rootDir, path.resolve(repoRoot, repoRelativePath)).split(path.sep).join("/"),
    );
  } catch {
    return [];
  }
}
