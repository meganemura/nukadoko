import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ScenarioRecord } from "./record-types.js";

// Responsibility: measure the commit and working-tree cleanliness a `nuka
// run` invocation started at (m4a-run-provenance task spec, decisions 2-3) —
// groundwork for `nuka accept` (docs/spec.md "Sign-off"), which is not
// implemented yet and does not call this module itself. Called once per run
// (cli/run.ts), never once per pickle (decision 4): a step that edits a
// tracked file mid-run must not change what every scenario record from that
// same run reports as its own starting point.
//
// One git call, not two (m4a-probe-cost task spec, decision 1): what costs
// time here isn't the git command itself (`status --porcelain` is 10-20ms
// standalone) but the child-process fork+exec, which contends when vitest's
// parallel workers all do it at once. `git status --porcelain=v2 --branch`
// reports the commit (a `# branch.oid ...` header line) and the working-tree
// state (any non-`#`-prefixed line) in one invocation, so `rev-parse` is no
// longer needed at all. `--porcelain=v2` is used deliberately, still never
// `-uno` (carried over from decision 3): an untracked step file is exactly
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
// `promisify` pattern for calling git (decision 3), including its fail-safe
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
