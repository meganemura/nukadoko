import { execFile } from "node:child_process";
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
// run removes when it ends.
//
// The C locale keeps git's own messages in English, so the one message
// that is matched (`not a git repository`) reads the same everywhere. A
// failure is a `GitRefError`, which the run refuses with, rather than a
// guess that a file is new.

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
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
