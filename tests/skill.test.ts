import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: `nuka skill path`/`nuka skill install` (m5a-acceptance-
// skill task spec). `path` never touches `rootDir` — its answer is a fact
// about the package, not the project — so every `runCli` call below still
// passes a `rootDir` (an empty temp dir) only because `runCli` itself
// requires one; it is never read for `path`. `install`'s destination *is*
// `rootDir`-relative (`.claude/skills/nukadoko-acceptance/`), so those
// tests read it back from the same temp dir they installed into.

describe("nuka skill path", () => {
  it("prints the skill source directory, and it exists", async () => {
    const rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["skill", "path"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const printed = stdout.text().trim();
    expect(existsSync(printed)).toBe(true);
    expect(existsSync(path.join(printed, "SKILL.md"))).toBe(true);
  });
});

describe("nuka skill install", () => {
  it("writes .claude/skills/nukadoko-acceptance/SKILL.md under rootDir", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();

      const exitCode = await runCli(["skill", "install"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      const installedPath = path.join(rootDir, ".claude", "skills", "nukadoko-acceptance", "SKILL.md");
      expect(existsSync(installedPath)).toBe(true);
      const content = await readFile(installedPath, "utf8");
      expect(content).toContain("name: nukadoko-acceptance");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("refuses to overwrite an existing .claude/skills/nukadoko-acceptance/, leaving it untouched", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      const destDir = path.join(rootDir, ".claude", "skills", "nukadoko-acceptance");
      await mkdir(destDir, { recursive: true });
      await writeFile(path.join(destDir, "SKILL.md"), "# hand-edited, do not clobber\n");

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["skill", "install"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("already exists");
      expect(stderr.text()).toContain("nuka skill path");
      const content = await readFile(path.join(destDir, "SKILL.md"), "utf8");
      expect(content).toBe("# hand-edited, do not clobber\n");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("acceptance skill source", () => {
  it("has frontmatter name and description", async () => {
    const content = await readFile(
      path.join(repoRoot, "skills", "acceptance", "SKILL.md"),
      "utf8",
    );
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    expect(frontmatter).toMatch(/^name:\s*nukadoko-acceptance\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*\S.*$/m);
  });
});

describe("nuka skill (process)", () => {
  it("resolves the same skill directory from dist/cli.js as from src/cli.ts via tsx", async () => {
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const rootDir = await createEmptyTempDir();
    try {
      const { stdout: distStdout, stderr: distStderr } = await execFileAsync(
        process.execPath,
        [cliPath, "skill", "path"],
        { cwd: rootDir },
      );
      expect(distStderr).toBe("");

      const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
      const tsxCliPath = path.join(repoRoot, "src", "cli.ts");
      const { stdout: tsxStdout, stderr: tsxStderr } = await execFileAsync(
        tsxBin,
        [tsxCliPath, "skill", "path"],
        { cwd: rootDir },
      );
      expect(tsxStderr).toBe("");

      expect(distStdout.trim()).toBe(tsxStdout.trim());
      expect(distStdout.trim()).toBe(path.join(repoRoot, "skills", "acceptance"));
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("installs the skill end to end when run against the built dist/cli.js", async () => {
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const rootDir = await createEmptyTempDir();
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "skill", "install"], {
        cwd: rootDir,
      });
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe(path.join(".claude", "skills", "nukadoko-acceptance"));
      const installedPath = path.join(rootDir, ".claude", "skills", "nukadoko-acceptance", "SKILL.md");
      expect(existsSync(installedPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
