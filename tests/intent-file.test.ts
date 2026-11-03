import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChangeIntent } from "../src/run/intent-file.js";

// Responsibility: which intent a change declares (src/run/intent-file.ts):
// none when the file is absent or the base already holds it unchanged, and
// otherwise the file with the commit that declared it, whether that was
// the change's first, and what changed it later, in a real repository.

const TABLE = "| Target | Observation | Before | After |\n| --- | --- | --- | --- |\n";

let dir: string | undefined;

function repository(): { readonly top: string; readonly git: (...args: string[]) => string } {
  dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-intent-"));
  const top = dir;
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: top, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(top, "app.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { top, git };
}

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readChangeIntent", () => {
  it("finds none when the file is absent, and none when the base holds it unchanged", async () => {
    const { top, git } = repository();
    const base = git("rev-parse", "HEAD");
    expect(await readChangeIntent(top, base)).toBeUndefined();
    writeFileSync(path.join(top, "INTENT.md"), TABLE);
    git("add", "-A");
    git("commit", "-q", "-m", "an earlier change's intent");
    writeFileSync(path.join(top, "app.txt"), "two\n");
    git("commit", "-q", "-am", "this change");
    expect(await readChangeIntent(top, git("rev-parse", "HEAD~1"))).toBeUndefined();
  });

  it("says the working tree alone holds an intent no commit declared", async () => {
    const { top, git } = repository();
    writeFileSync(path.join(top, "INTENT.md"), TABLE);
    const read = await readChangeIntent(top, git("rev-parse", "HEAD"));
    expect(read?.record).toEqual({ file: "INTENT.md", declared_in: null, changed_after: [], uncommitted: true, problems: [] });
    expect(read?.intent).toEqual({ rows: [], problems: [] });
  });

  it("names an intent declared after the change's first commit, and each later change of it", async () => {
    const { top, git } = repository();
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(top, "app.txt"), "two\n");
    git("commit", "-q", "-am", "start the work");
    writeFileSync(path.join(top, "INTENT.md"), TABLE);
    git("add", "-A");
    git("commit", "-q", "-m", "declare");
    const declared = git("rev-parse", "HEAD");
    writeFileSync(path.join(top, "INTENT.md"), `${TABLE}| @a | http | 0 | 1 |\n`);
    git("commit", "-q", "-am", "widen");
    const widened = git("rev-parse", "HEAD");
    const read = await readChangeIntent(top, base);
    expect(read?.record).toEqual({
      file: "INTENT.md",
      declared_in: { commit: declared, subject: "declare", first: false },
      changed_after: [{ commit: widened, subject: "widen" }],
      uncommitted: false,
      problems: [],
    });
    expect(read?.intent.rows.map((row) => row.cells)).toEqual([{ target: "@a", observation: "http", before: "0", after: "1" }]);
  });

  it("names the file from a project below the repository's top", async () => {
    const { top, git } = repository();
    mkdirSync(path.join(top, "web"));
    writeFileSync(path.join(top, "INTENT.md"), TABLE);
    expect((await readChangeIntent(path.join(top, "web"), git("rev-parse", "HEAD")))?.record.file).toBe("../INTENT.md");
  });
});
