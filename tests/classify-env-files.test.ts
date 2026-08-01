import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyEnvFiles } from "../src/secrets/classify-env-files.js";
import { copyFixtureToTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: docs/spec.md "Secrets" says git is the classifier; these
// tests exercise the three cases that follow from that, directly against
// this repository's own git state, rather than spinning up throwaway git
// repos:
//   - tracked: an already-committed fixture path, used directly (this task
//     spec's own guidance) — classifyEnvFiles doesn't care about a file's
//     content or format, only whether git tracks that path.
//   - secret source via gitignore: a fixture copied into
//     tests/.tmp-fixtures, which .gitignore excludes wholesale, so any path
//     under it is untracked regardless of the original's status.
//   - secret source via git being entirely inapplicable: an OS temp
//     directory outside this repository, where `git -C <dir> ls-files`
//     itself fails.

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
});
