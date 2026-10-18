import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Responsibility: what `nuka run --since <ref>` reads from git: the commit a
// ref names, and a file's text at that commit. Boundary: git I/O only; the
// comparison is src/run/criteria-since.ts, and the refusal text and code are
// src/cli/run.ts's.
//
// Read-only, like src/run/probe-git.ts: `rev-parse` and `show`, never a
// command that moves HEAD or touches the index. A path is passed as
// `<commit>:./<path>`, which git resolves against `-C`'s directory, so a
// project that sits in a subdirectory of its repository names its files
// the way the run does, relative to the project root.

const execFileAsync = promisify(execFile);

export type SinceResolution =
  | { readonly commit: string }
  | { readonly problem: "outside-git" | "unknown-ref"; readonly message: string };

/** The commit `ref` names in the repository that holds `rootDir`. */
export async function resolveSince(rootDir: string, ref: string): Promise<SinceResolution> {
  try {
    await execFileAsync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  } catch {
    return { problem: "outside-git", message: `nuka run --since ${ref} needs a git repository, and the project directory is not inside one` };
  }
  // A ref that starts with `-` would read as an option to git.
  if (ref.length === 0 || ref.startsWith("-")) {
    return { problem: "unknown-ref", message: `--since ${JSON.stringify(ref)} names no commit` };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
    const commit = stdout.trim();
    if (commit.length > 0) return { commit };
  } catch {
    // Not a commit: the refusal below.
  }
  return { problem: "unknown-ref", message: `--since ${ref} names no commit in the project's repository` };
}

/** The text of `relativePath` (relative to `rootDir`) at `commit`, or
 * `undefined` when the commit holds no such file. */
export async function readAtCommit(rootDir: string, commit: string, relativePath: string): Promise<string | undefined> {
  const posix = relativePath.split(path.sep).join("/");
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootDir, "show", `${commit}:./${posix}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Whether the file at `relativePath` differs from its text at `commit`:
 * a file the commit does not hold has changed, and so has one the working
 * tree no longer holds. */
export async function changedSince(rootDir: string, commit: string, relativePath: string): Promise<boolean> {
  const before = await readAtCommit(rootDir, commit, relativePath);
  let now: string | undefined;
  try {
    now = await readFile(path.join(rootDir, relativePath), "utf8");
  } catch {
    now = undefined;
  }
  return before === undefined || now === undefined || before !== now;
}
