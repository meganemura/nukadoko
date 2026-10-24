import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Responsibility: what `nuka run --base <ref>` asks git: the commit a ref
// names, whether the clone is shallow, where the project sits in its
// repository, which files a tree holds, and a detached worktree of the ref
// to build the base world in. Boundary: git I/O only; what the files mean
// is src/run/base-run.ts's, and the refusal text and code are
// src/cli/run.ts's.
//
// Read-only in the project's own tree: `rev-parse` and `ls-files`, never
// a command that moves HEAD or touches the index. The one write is the
// worktree, which git keeps under the repository's own metadata and the
// run removes when it ends. A run a SIGKILL ended cannot remove its own,
// so the next `nuka run --base` and `nuka clean` remove each registration
// whose directory is under the state directory's runs and no longer exists,
// and touch no other.
//
// Every command runs with `core.hooksPath` set to `/dev/null`, so making
// a tree never runs the repository's hooks (a `post-checkout` hook sees
// the tree as a checkout of its own and could act on it). Checkout filters
// (`.gitattributes` filters, Git LFS) stay on: they are how the repository
// turns its objects into the files its code is.
//
// The C locale keeps git's own messages in English, so the one message
// that is matched (`not a git repository`) reads the same everywhere. A
// failure is a `GitRefError`, which the run refuses with, rather than a
// guess that a file is new.

const execFileAsync = promisify(execFile);

/** Leads every git command nukadoko runs against a tree (module header). */
export const NO_HOOKS: readonly string[] = ["-c", "core.hooksPath=/dev/null"];

/** A git command `--base` needs that did not answer. */
export class GitRefError extends Error {
  readonly command: string;
  constructor(command: string, cause: string) {
    super(`${command} failed: ${cause}`);
    this.command = command;
    this.name = "GitRefError";
  }
}

function describeFailure(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (failure.code === "ENOENT") return "git is not installed, or not on PATH";
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim().split("\n")[0] : "";
  return stderr !== undefined && stderr !== "" ? stderr : String(failure.message ?? error);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...NO_HOOKS, "-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout;
  } catch (error) {
    throw new GitRefError(`git ${args.join(" ")}`, describeFailure(error));
  }
}

export type RefResolution =
  | { readonly commit: string }
  | { readonly problem: "outside-git" | "unknown-ref" | "shallow" | "git-failed"; readonly message: string; readonly fetch?: string };

/** What fetches the history a shallow clone needs for a ref it cannot
 * resolve, when the ref does not say which commit or branch to fetch. */
export const UNSHALLOW_COMMAND = "git fetch --unshallow origin";

/** A name git can fetch by: what `git check-ref-format` accepts, closely
 * enough that a revision expression (`main~2`, `v1^{commit}`, `@{u}`)
 * is never one. */
function plainRefName(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//")
  );
}

/** The command that fetches `ref` into a shallow clone, so that the same
 * `--base` resolves afterwards. A full commit hash fetches that commit, a
 * remote-tracking name (`origin/main`) its branch into that name, a
 * branch name the branch from `origin` under its own name, and a full
 * `refs/` name the same ref from `origin` (from its remote for
 * `refs/remotes/`). A
 * server fetches a commit only by its full hash, and a revision expression
 * names no ref to fetch, so an abbreviated hash, or any name that is not one
 * of those, fetches the whole history instead (`UNSHALLOW_COMMAND`). Pure. */
export function fetchCommandFor(ref: string): string {
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) return `git fetch --no-tags --depth=1 origin ${ref}`;
  if (/^[0-9a-f]{7,63}$/.test(ref) || !plainRefName(ref)) return UNSHALLOW_COMMAND;
  const branch = (name: string): string => `git fetch --no-tags --depth=1 origin ${name}:refs/heads/${name}`;
  const tracking = (remote: string, name: string): string => `git fetch --no-tags --depth=1 ${remote} ${name}:refs/remotes/${remote}/${name}`;
  if (ref.startsWith("refs/")) {
    const heads = /^refs\/heads\/(.+)$/.exec(ref);
    if (heads !== null) return branch(heads[1]!);
    const remotes = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
    if (remotes !== null) return tracking(remotes[1]!, remotes[2]!);
    return `git fetch --no-tags --depth=1 origin ${ref}:${ref}`;
  }
  const slash = ref.indexOf("/");
  if (slash > 0) return tracking(ref.slice(0, slash), ref.slice(slash + 1));
  return branch(ref);
}

/** The commit `ref` names in the repository that holds `rootDir`. A
 * shallow clone that lacks it is told apart from a ref that names nothing,
 * since the fix differs: fetch it. */
export async function resolveRef(rootDir: string, ref: string): Promise<RefResolution> {
  let shallow: boolean;
  try {
    shallow = (await git(rootDir, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  } catch (error) {
    const message = (error as GitRefError).message;
    if (/not a git repository/.test(message)) {
      return { problem: "outside-git", message: `nuka run --base ${ref} needs a git repository, and the project directory is not inside one` };
    }
    return { problem: "git-failed", message: `nuka run --base ${ref} could not ask git where the project is: ${message}` };
  }
  // A ref that starts with `-` would read as an option to git.
  if (ref.length === 0 || ref.startsWith("-")) {
    return { problem: "unknown-ref", message: `--base ${JSON.stringify(ref)} names no commit` };
  }
  try {
    const commit = (await git(rootDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    if (commit.length > 0) return { commit };
  } catch {
    // `--verify --quiet` exits 1 with nothing on stderr for a ref that
    // names no commit: the refusals below.
  }
  if (shallow) {
    return {
      problem: "shallow",
      message: `--base ${ref} names no commit in this shallow clone, which holds only part of the history; fetch the base first`,
      fetch: fetchCommandFor(ref),
    };
  }
  return { problem: "unknown-ref", message: `--base ${ref} names no commit in the project's repository` };
}

/** The repository's top directory and the project's path inside it, with
 * `/` separators and no trailing one (`""` at the top). */
export async function repositoryPlace(rootDir: string): Promise<{ readonly top: string; readonly prefix: string }> {
  const top = (await git(rootDir, ["rev-parse", "--show-toplevel"])).trim();
  const prefix = (await git(rootDir, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "");
  return { top, prefix };
}

function nulList(out: string): string[] {
  return out.split("\0").filter((name) => name.length > 0);
}

/** The files of the working tree at `top`, relative to it: tracked ones
 * and untracked ones git does not ignore, as a copy of the working tree
 * holds them. A tracked file deleted from disk is listed too; the caller
 * checks the disk. */
export async function workingTreeFiles(top: string): Promise<string[]> {
  return nulList(await git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
}

/** The files a checkout of a commit holds, relative to its top. */
export async function trackedFiles(top: string): Promise<string[]> {
  return nulList(await git(top, ["ls-files", "-z", "--cached"]));
}

/** A detached worktree of `commit` at `dir`. */
export async function addWorktree(top: string, dir: string, commit: string): Promise<void> {
  await git(top, ["worktree", "add", "--detach", "--quiet", dir, commit]);
}

/** Removes the worktree at `dir`, with what the run wrote into it. */
export async function removeWorktree(top: string, dir: string): Promise<void> {
  await git(top, ["worktree", "remove", "--force", "--force", dir]);
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Removes each worktree registration of the repository holding `rootDir`
 * whose directory lies under `runsDir` and no longer exists: what a run
 * that could not remove its tree left behind (module header). Every other
 * registration stays, a missing one included. Returns the directories it
 * removed; a project outside git has none. */
export async function removeStaleTreeRegistrations(rootDir: string, runsDir: string): Promise<string[]> {
  let listing: string;
  try {
    listing = await git(rootDir, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  // git names a worktree by the path it was given or by its real path, so
  // either spelling of the runs directory counts.
  const roots = [path.resolve(runsDir)];
  try {
    roots.push(realpathSync(path.dirname(path.resolve(runsDir))) + path.sep + path.basename(runsDir));
  } catch {
    // The state directory is gone too: the resolved spelling is all there is.
  }
  const removed: string[] = [];
  for (const field of listing.split("\n")) {
    if (!field.startsWith("worktree ")) continue;
    const dir = field.slice("worktree ".length);
    if (!roots.some((root) => inside(root, dir)) || existsSync(dir)) continue;
    try {
      await git(rootDir, ["worktree", "remove", "--force", "--force", dir]);
      removed.push(dir);
    } catch {
      // Another process removed it first: nothing is left to remove.
    }
  }
  return removed;
}
