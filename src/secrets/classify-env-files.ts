import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Responsibility: decide which of a project's configured envFiles are
// "secret sources" per docs/spec.md "Sessions, environments, secrets". Git is the classifier, not
// nukadoko. An env file git does not track (ignored or untracked; the two
// are never distinguished, both are uncommitted) is a secret source: every
// value it defines is a secret. A tracked env file is plain configuration
// only when its working tree matches HEAD, because that is when the values
// on disk are the committed ones. An uncommitted edit, staged or not, is
// a secret source too. `git ls-files` runs once for the whole envFiles
// list rather than once per file, and so does the HEAD diff that follows
// when anything is tracked. Any failure of either git call (no git binary
// on PATH, rootDir outside a git repository, no HEAD yet, or anything
// else) falls back to treating every configured file as a secret source:
// classification must fail safe, and must never fail the run itself. A
// `do` execution's own outcome does not depend on git being present or on
// rootDir being a repository.

const execFileAsync = promisify(execFile);

export interface EnvFileClassification {
  /** Tracked by git and matching HEAD: plain configuration, not a
   * redaction source on its own. */
  readonly tracked: readonly string[];
  /** Untracked, ignored, or tracked but different from HEAD. Also the
   * fallback when classification itself failed. Every value these files
   * define is a secret (subject to `secrets.public`, applied later by
   * build-secret-set.ts). */
  readonly secretSource: readonly string[];
}

export async function classifyEnvFiles(
  rootDir: string,
  envFiles: readonly string[],
): Promise<EnvFileClassification> {
  if (envFiles.length === 0) {
    return { tracked: [], secretSource: [] };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", rootDir, "ls-files", "-z", "--", ...envFiles],
      { encoding: "utf8" },
    ));
  } catch {
    return { tracked: [], secretSource: [...envFiles] };
  }

  const trackedSet = new Set(nulPaths(stdout));
  const trackedFiles = envFiles.filter((file) => trackedSet.has(file));

  // `git diff HEAD` compares the working tree to the commit, so a staged
  // edit counts even when the worktree matches the index. `--relative`
  // prints paths relative to rootDir. `ls-files` already does that, and
  // without the flag a dirty file under a subdirectory would not match
  // the path the caller configured, so it would stay plain configuration.
  let dirty = new Set<string>();
  if (trackedFiles.length > 0) {
    try {
      const { stdout: diffStdout } = await execFileAsync(
        "git",
        ["-C", rootDir, "diff", "-z", "--name-only", "--relative", "HEAD", "--", ...trackedFiles],
        { encoding: "utf8" },
      );
      dirty = new Set(nulPaths(diffStdout));
    } catch {
      dirty = new Set(trackedFiles);
    }
  }

  const tracked: string[] = [];
  const secretSource: string[] = [];
  for (const file of envFiles) {
    if (trackedSet.has(file) && !dirty.has(file)) {
      tracked.push(file);
    } else {
      secretSource.push(file);
    }
  }
  return { tracked, secretSource };
}

function nulPaths(stdout: string): string[] {
  // `-z` NUL-terminates entries instead of newline-separating them, so a
  // path containing a literal newline (rare, but legal on POSIX
  // filesystems) still splits correctly. The trailing NUL after the last
  // entry, or the entire output when nothing matched, would otherwise
  // leave one spurious empty string.
  return stdout.split("\0").filter((entry) => entry !== "");
}
