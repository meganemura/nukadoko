import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildSecretSet } from "../src/secrets/build-secret-set.js";
import { classifyEnvFiles } from "../src/secrets/classify-env-files.js";
import { redactString } from "../src/secrets/redact.js";
import { copyFixtureToTempDir, initGitRepo, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: docs/spec.md "Secrets" says git is the classifier; these
// tests exercise the cases that follow from that. The committed cases run
// directly against this repository's own git state, rather than spinning up
// throwaway git repos:
//   - tracked: an already-committed fixture path, used directly.
//     classifyEnvFiles does not read the file's content or format. It asks
//     whether git tracks that path and whether the working tree matches HEAD.
//   - secret source via gitignore: a fixture copied into
//     tests/.tmp-fixtures, which .gitignore excludes wholesale, so any path
//     under it is untracked regardless of the original's status.
//   - secret source via git being entirely inapplicable: an OS temp
//     directory outside this repository, where `git -C <dir> ls-files`
//     itself fails.
// An uncommitted edit of a tracked file cannot be shown from this
// repository's committed tree without mutating it, so that case uses a
// throwaway repository.

describe("classifyEnvFiles", () => {
  it("classifies an already-committed path as tracked", async () => {
    const result = await classifyEnvFiles(repoRoot, [
      path.join("tests", "fixtures", "do-project", "nukadoko-shim.ts"),
    ]);
    expect(result).toEqual({
      tracked: [path.join("tests", "fixtures", "do-project", "nukadoko-shim.ts")],
      secretSource: [],
    });
  });

  it("classifies a path git does not track as a secret source, alongside a tracked one", async () => {
    const result = await classifyEnvFiles(repoRoot, [
      path.join("tests", "fixtures", "do-project", "nukadoko-shim.ts"),
      "definitely-untracked-env-file.env",
    ]);
    expect(result).toEqual({
      tracked: [path.join("tests", "fixtures", "do-project", "nukadoko-shim.ts")],
      secretSource: ["definitely-untracked-env-file.env"],
    });
  });

  it("classifies a path under a gitignored directory as a secret source", async () => {
    const fixtureDir = await copyFixtureToTempDir("do-project");
    try {
      const result = await classifyEnvFiles(fixtureDir, ["nukadoko-shim.ts"]);
      expect(result).toEqual({ tracked: [], secretSource: ["nukadoko-shim.ts"] });
    } finally {
      await removeTempDir(fixtureDir);
    }
  });

  it("falls back to treating every envFile as a secret source outside a git repository", async () => {
    const outsideRepo = await mkdtemp(path.join(os.tmpdir(), "nukadoko-no-git-"));
    try {
      const result = await classifyEnvFiles(outsideRepo, [".env", "other.env"]);
      expect(result).toEqual({ tracked: [], secretSource: [".env", "other.env"] });
    } finally {
      await rm(outsideRepo, { recursive: true, force: true });
    }
  });

  it("returns empty classifications with no envFiles configured", async () => {
    expect(await classifyEnvFiles(repoRoot, [])).toEqual({ tracked: [], secretSource: [] });
  });

  it("classifies uncommitted edits in a tracked env file as a secret source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-dirty-env-"));
    const git = (args: string[]) => execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      await writeFile(path.join(dir, ".env.test"), "API_TOKEN=changeme\n");
      await writeFile(path.join(dir, ".env.clean"), "APP_NAME=demo\n");
      await mkdir(path.join(dir, "sub"));
      await writeFile(path.join(dir, "sub", ".env"), "API_TOKEN=changeme\n");
      await initGitRepo(dir);

      expect(await classifyEnvFiles(dir, [".env.test", ".env.clean"])).toEqual({
        tracked: [".env.test", ".env.clean"],
        secretSource: [],
      });

      await writeFile(path.join(dir, ".env.test"), "API_TOKEN=real-token-value\n");
      const dirty = await classifyEnvFiles(dir, [".env.test", ".env.clean"]);
      expect(dirty).toEqual({
        tracked: [".env.clean"],
        secretSource: [".env.test"],
      });
      const dirtySecrets = buildSecretSet(dir, {
        secretSourceFiles: dirty.secretSource,
        trackedFiles: dirty.tracked,
        publicKeys: [],
      });
      expect(redactString("saw real-token-value and changeme and demo", dirtySecrets)).toBe(
        "saw {{secret.API_TOKEN}} and changeme and demo",
      );

      // Staged edits differ from HEAD even when the worktree matches the index.
      await git(["add", "--", ".env.test"]);
      expect(await classifyEnvFiles(dir, [".env.test", ".env.clean"])).toEqual({
        tracked: [".env.clean"],
        secretSource: [".env.test"],
      });

      await git(["commit", "-q", "-m", "update token"]);
      const committed = await classifyEnvFiles(dir, [".env.test", ".env.clean"]);
      expect(committed).toEqual({
        tracked: [".env.test", ".env.clean"],
        secretSource: [],
      });
      const committedSecrets = buildSecretSet(dir, {
        secretSourceFiles: committed.secretSource,
        trackedFiles: committed.tracked,
        publicKeys: [],
      });
      expect(redactString("saw real-token-value", committedSecrets)).toBe("saw real-token-value");

      await writeFile(path.join(dir, "sub", ".env"), "API_TOKEN=subdir-token-value\n");
      const nested = await classifyEnvFiles(path.join(dir, "sub"), [".env"]);
      expect(nested).toEqual({ tracked: [], secretSource: [".env"] });
      const nestedSecrets = buildSecretSet(path.join(dir, "sub"), {
        secretSourceFiles: nested.secretSource,
        trackedFiles: nested.tracked,
        publicKeys: [],
      });
      expect(redactString("saw subdir-token-value", nestedSecrets)).toBe(
        "saw {{secret.API_TOKEN}}",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
