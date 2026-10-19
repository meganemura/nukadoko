import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { StepFileChange } from "../record/run-result.js";

// Responsibility: what `nuka run --since <ref>` reads from git: the commit a
// ref names, a file's text at that commit, the feature files the commit
// holds under a directory, and whether a working-tree file differs from the
// commit. Boundary: git I/O only; the comparison is
// src/run/criteria-since.ts, and the refusal text and code are
// src/cli/run.ts's.
//
// Read-only, like src/run/probe-git.ts: `rev-parse`, `ls-tree`, `show`,
// and `diff --quiet`, never a command that moves HEAD or touches the index.
// A path is passed relative to `-C`'s directory (`<commit>:./<path>` for
// `show`), so a project that sits in a subdirectory of its repository
// names its files the way the run does, relative to the project root.
//
// "The commit does not hold this file" is told apart from every other git
// failure, by `ls-tree`, whose output is empty for an absent path and whose
// exit code is not 0 only for a real error. The alternative refused was
// `git cat-file -e`, which exits 128 for an absent path and for a broken
// repository alike, and `git show`'s failure, which reads a missing git
// binary as a missing file. Any other failure is a `SinceGitError`, which
// the run refuses with, rather than a guess that the file is new.

const execFileAsync = promisify(execFile);

/** A git command `--since` needs that did not answer. */
export class SinceGitError extends Error {
  readonly command: string;
  constructor(command: string, cause: string) {
    super(`${command} failed: ${cause}`);
    this.command = command;
    this.name = "SinceGitError";
  }
}

function describeFailure(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (failure.code === "ENOENT") return "git is not installed, or not on PATH";
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim().split("\n")[0] : "";
  return stderr !== undefined && stderr !== "" ? stderr : String(failure.message ?? error);
}

async function git(rootDir: string, args: readonly string[]): Promise<string> {
  try {
    // The C locale keeps git's own messages in English, so the one message
    // that is matched (`not a git repository`) reads the same everywhere.
    const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout;
  } catch (error) {
    throw new SinceGitError(`git ${args.join(" ")}`, describeFailure(error));
  }
}

export type SinceResolution =
  | { readonly commit: string }
  | { readonly problem: "outside-git" | "unknown-ref" | "git-failed"; readonly message: string };

/** The commit `ref` names in the repository that holds `rootDir`. */
export async function resolveSince(rootDir: string, ref: string): Promise<SinceResolution> {
  try {
    await git(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = (error as SinceGitError).message;
    if (/not a git repository/.test(message)) {
      return { problem: "outside-git", message: `nuka run --since ${ref} needs a git repository, and the project directory is not inside one` };
    }
    return { problem: "git-failed", message: `nuka run --since ${ref} could not ask git where the project is: ${message}` };
  }
  // A ref that starts with `-` would read as an option to git.
  if (ref.length === 0 || ref.startsWith("-")) {
    return { problem: "unknown-ref", message: `--since ${JSON.stringify(ref)} names no commit` };
  }
  try {
    const commit = (await git(rootDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    if (commit.length > 0) return { commit };
  } catch {
    // `--verify --quiet` exits 1 with nothing on stderr for a ref that
    // names no commit: the refusal below.
  }
  return { problem: "unknown-ref", message: `--since ${ref} names no commit in the project's repository` };
}

function posix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

async function holds(rootDir: string, commit: string, relativePath: string): Promise<boolean> {
  return (await git(rootDir, ["ls-tree", "-z", "--name-only", commit, "--", `./${posix(relativePath)}`])).length > 0;
}

/** The text of `relativePath` (relative to `rootDir`) at `commit`, or
 * `undefined` when the commit holds no such file. */
export async function readAtCommit(rootDir: string, commit: string, relativePath: string): Promise<string | undefined> {
  if (!(await holds(rootDir, commit, relativePath))) return undefined;
  return git(rootDir, ["show", `${commit}:./${posix(relativePath)}`]);
}

/** The `.feature` files `commit` holds at or under `target`, relative to
 * `rootDir`, sorted. */
export async function listFeatureFilesAtCommit(rootDir: string, commit: string, target: string): Promise<string[]> {
  const out = await git(rootDir, ["ls-tree", "-r", "-z", "--name-only", commit, "--", `./${posix(target)}`]);
  return out
    .split("\0")
    .filter((name) => name.endsWith(".feature"))
    .map((name) => name.split("/").join(path.sep))
    .sort((a, b) => a.localeCompare(b));
}

/** Whether the working-tree file at `relativePath` differs from `commit`,
 * as git compares them (line endings and filters applied), or
 * `untracked` when the commit does not hold it. */
export async function stepFileChange(rootDir: string, commit: string, relativePath: string): Promise<StepFileChange> {
  if (!(await holds(rootDir, commit, relativePath))) return "untracked";
  const args = ["-C", rootDir, "diff", "--quiet", commit, "--", `./${posix(relativePath)}`];
  try {
    await execFileAsync("git", args, { env: { ...process.env, LC_ALL: "C" } });
    return "unchanged";
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return "changed";
    throw new SinceGitError(`git ${args.slice(2).join(" ")}`, describeFailure(error));
  }
}
