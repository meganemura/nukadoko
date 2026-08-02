import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: `nuka skill path`, and skills/acceptance/SKILL.md's own
// compliance with the open Agent Skills specification
// (https://agentskills.io/specification) that `gh skill install` and other
// multi-host tooling read (m5e-skill-spec-compliance task spec). `install`
// was removed — see src/cli/skill.ts's header for why — so this file only
// exercises `path`, plus the frontmatter/body shape of the skill source
// itself. That second half exists to catch the actual bug this task fixes:
// `name: nukadoko-acceptance` didn't match its `skills/acceptance/`
// directory, which a spec-compliant runtime refuses to load — the "name
// matches parent directory" test below is a direct regression guard for
// that.

const skillDir = path.join(repoRoot, "skills", "acceptance");

async function readFrontmatter(): Promise<string> {
  const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatterMatch).not.toBeNull();
  return frontmatterMatch![1]!;
}

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

describe("acceptance skill source: Agent Skills specification compliance", () => {
  it("has frontmatter name and description", async () => {
    const frontmatter = await readFrontmatter();
    expect(frontmatter).toMatch(/^name:\s*\S.*$/m);
    expect(frontmatter).toMatch(/^description:\s*\S.*$/m);
  });

  it("has a name matching its parent directory (skills/acceptance/)", async () => {
    const frontmatter = await readFrontmatter();
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]!.trim()).toBe(path.basename(skillDir));
  });

  it("has a name of 1-64 lowercase alphanumeric/hyphen characters (no leading, trailing, or doubled hyphen)", async () => {
    const frontmatter = await readFrontmatter();
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    expect(nameMatch).not.toBeNull();
    const name = nameMatch![1]!.trim();
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(64);
    // This single regex rejects leading/trailing hyphens and doubled
    // hyphens at once: each `-` must sit between two `[a-z0-9]+` groups.
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("has a description between 1 and 1024 characters", async () => {
    const frontmatter = await readFrontmatter();
    const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
    expect(descriptionMatch).not.toBeNull();
    const description = descriptionMatch![1]!.trim();
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("has a compatibility field of at most 500 characters, if present", async () => {
    const frontmatter = await readFrontmatter();
    const compatibilityMatch = frontmatter.match(/^compatibility:\s*(.+)$/m);
    if (compatibilityMatch) {
      expect(compatibilityMatch[1]!.trim().length).toBeLessThanOrEqual(500);
    }
  });

  it("has a body under 500 lines", async () => {
    const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const lineCount = body.split("\n").length;
    expect(lineCount).toBeLessThan(500);
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
      expect(distStdout.trim()).toBe(skillDir);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
