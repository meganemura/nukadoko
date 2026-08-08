import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Responsibility: decide which of a project's configured envFiles are
// "secret sources" per docs/spec.md "Secrets" — git is the classifier, not
// nukadoko. An env file git does not track (ignored or untracked; the two
// are never distinguished, both are uncommitted) is a secret source: every
// value it defines is a secret. A tracked env file is plain configuration.
// `git ls-files` is run once for the whole envFiles list rather than once
// per file. Any failure of the git call itself (no git binary on PATH,
// rootDir outside a git repository, or anything else) falls back to
// treating every configured file as a secret source: classification must
// fail *safe*, and must never fail the run itself — a `do` execution's own
// outcome does not depend on git being
// present or on rootDir being a repository.

const execFileAsync = promisify(execFile);

export interface EnvFileClassification {
  /** Tracked by git: plain configuration, never a redaction source. */
  readonly tracked: readonly string[];
  /** Not tracked by git — including when classification itself failed and
   * fell back to this safe default. Every value these files define is a
   * secret (subject to `secrets.public`, applied later by build-secret-set.ts). */
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

  // `-z` NUL-terminates entries instead of newline-separating them, so a
  // path containing a literal newline (rare, but legal on POSIX
  // filesystems) still splits correctly; the trailing NUL after the last
  // entry (or the entire output when nothing matched) would otherwise leave
  // one spurious empty string, hence the filter.
  const trackedSet = new Set(stdout.split("\0").filter((entry) => entry !== ""));

  const tracked: string[] = [];
  const secretSource: string[] = [];
  for (const file of envFiles) {
    (trackedSet.has(file) ? tracked : secretSource).push(file);
  }
  return { tracked, secretSource };
}
