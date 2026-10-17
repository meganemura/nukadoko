import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { listCheckCodes } from "../src/check/codes.js";
import { runCli } from "../src/cli/run-cli.js";
import { TEND_CODES } from "../src/tend/types.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: `nuka skill path`, and every skills/*/SKILL.md's own
// compliance with the open Agent Skills specification
// (https://agentskills.io/specification) that `gh skill install` and other
// multi-host tooling read (covers skills/migration too). `install` was
// removed —
// see src/cli/skill.ts's header for why — so this file only exercises
// `path`, plus the frontmatter/body shape of each skill source itself. The
// compliance half exists to catch the actual bug this task fixes:
// `name: nukadoko-acceptance` didn't match its `skills/acceptance/`
// directory, which a spec-compliant runtime refuses to load — the "name
// matches parent directory" test below is a direct regression guard for
// that, and it now runs for every skill directory, not just acceptance.

const skillsDir = path.join(repoRoot, "skills");
const skillNames = ["acceptance", "migration"];

async function readFrontmatterOf(name: string): Promise<string> {
  const content = await readFile(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatterMatch).not.toBeNull();
  return frontmatterMatch![1]!;
}

describe("nuka skill path", () => {
  it("prints the directory holding every shipped skill", async () => {
    const rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["skill", "path"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const printed = stdout.text().trim();
    expect(existsSync(printed)).toBe(true);
    // The parent, not any one skill: every shipped skill sits under it.
    for (const name of skillNames) {
      expect(existsSync(path.join(printed, name, "SKILL.md"))).toBe(true);
    }
  });
});

for (const name of skillNames) {
  describe(`${name} skill source: Agent Skills specification compliance`, () => {
    const dir = path.join(repoRoot, "skills", name);

    it("has frontmatter name and description", async () => {
      const frontmatter = await readFrontmatterOf(name);
      expect(frontmatter).toMatch(/^name:\s*\S.*$/m);
      expect(frontmatter).toMatch(/^description:\s*\S.*$/m);
    });

    it(`has a name matching its parent directory (skills/${name}/)`, async () => {
      const frontmatter = await readFrontmatterOf(name);
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      expect(nameMatch).not.toBeNull();
      expect(nameMatch![1]!.trim()).toBe(path.basename(dir));
    });

    it("has a name of 1-64 lowercase alphanumeric/hyphen characters (no leading, trailing, or doubled hyphen)", async () => {
      const frontmatter = await readFrontmatterOf(name);
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      expect(nameMatch).not.toBeNull();
      const skillName = nameMatch![1]!.trim();
      expect(skillName.length).toBeGreaterThanOrEqual(1);
      expect(skillName.length).toBeLessThanOrEqual(64);
      // This single regex rejects leading/trailing hyphens and doubled
      // hyphens at once: each `-` must sit between two `[a-z0-9]+` groups.
      expect(skillName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("has a description between 1 and 1024 characters", async () => {
      const frontmatter = await readFrontmatterOf(name);
      const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
      expect(descriptionMatch).not.toBeNull();
      const description = descriptionMatch![1]!.trim();
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(1024);
    });

    it("has a compatibility field of at most 500 characters, if present", async () => {
      const frontmatter = await readFrontmatterOf(name);
      const compatibilityMatch = frontmatter.match(/^compatibility:\s*(.+)$/m);
      if (compatibilityMatch) {
        expect(compatibilityMatch[1]!.trim().length).toBeLessThanOrEqual(500);
      }
    });

    it("has a body under 500 lines", async () => {
      const content = await readFile(path.join(dir, "SKILL.md"), "utf8");
      const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
      const lineCount = body.split("\n").length;
      expect(lineCount).toBeLessThan(500);
    });

    it("only points at references/ files that actually exist", async () => {
      // A skill that names a reference and doesn't ship it distributes a
      // broken pointer (skills/ is in package.json's `files`, so a reader
      // outside this repository hits exactly this path). Vacuous for a
      // skill with no references/*.md mentions at all.
      const content = await readFile(path.join(dir, "SKILL.md"), "utf8");
      // A path that starts at skills/ points into another skill and
      // resolves from the repository root.
      const referencePaths = [...content.matchAll(/(?:skills\/[a-z0-9-]+\/)?references\/[a-z0-9-]+\.md/g)].map(
        (m) => m[0],
      );
      for (const referencePath of new Set(referencePaths)) {
        const base = referencePath.startsWith("skills/") ? path.join(dir, "..", "..") : dir;
        expect(existsSync(path.join(base, referencePath)), referencePath).toBe(true);
      }
    });
  });
}

describe("nuka skill (process)", () => {
  it("resolves the same skill directory from dist/cli.js as from src/cli.ts", async () => {
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const rootDir = await createEmptyTempDir();
    try {
      const { stdout: distStdout, stderr: distStderr } = await execFileAsync(
        process.execPath,
        [cliPath, "skill", "path"],
        { cwd: rootDir },
      );
      expect(distStderr).toBe("");

      const sourceCliPath = path.join(repoRoot, "src", "cli.ts");
      const { stdout: sourceStdout, stderr: sourceStderr } = await execFileAsync(
        process.execPath,
        [...sourceNodeArgs, sourceCliPath, "skill", "path"],
        { cwd: rootDir },
      );
      expect(sourceStderr).toBe("");

      expect(distStdout.trim()).toBe(sourceStdout.trim());
      expect(distStdout.trim()).toBe(skillsDir);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

// The acceptance skill is read by an agent with a context budget, so its
// size is a contract: SKILL.md is the order of work and stays at 120 lines,
// each reference stays at 200, and a rule that does not fit replaces one
// that is there. The worked examples are exempt because their output
// blocks are copied from real runs, not written to a length.
const SKILL_MD_BUDGET = 120;
const REFERENCE_BUDGET = 200;

function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function budgetProblems(skillDir: string): string[] {
  const problems: string[] = [];
  const skillLines = lineCount(readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
  if (skillLines > SKILL_MD_BUDGET) problems.push(`SKILL.md has ${skillLines} lines, over ${SKILL_MD_BUDGET}`);
  const referencesDir = path.join(skillDir, "references");
  for (const entry of readdirSync(referencesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const lines = lineCount(readFileSync(path.join(referencesDir, entry.name), "utf8"));
    if (lines > REFERENCE_BUDGET) problems.push(`references/${entry.name} has ${lines} lines, over ${REFERENCE_BUDGET}`);
  }
  return problems;
}

describe("acceptance skill size budget", () => {
  it("counts the lines wc -l counts", () => {
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab \t`" }), { maxSize: 40 }));
      expect(lineCount(lines.map((line) => `${line}\n`).join(""))).toBe(lines.length);
      if (lines.length > 0 && lines.at(-1) !== "") expect(lineCount(lines.join("\n"))).toBe(lines.length);
    });
  });

  it("keeps SKILL.md and every reference within budget", () => {
    expect(budgetProblems(path.join(skillsDir, "acceptance"))).toEqual([]);
  });

  it("names a SKILL.md and a reference one line over budget, and leaves examples/ alone", async () => {
    const skillDir = await createEmptyTempDir();
    try {
      await mkdir(path.join(skillDir, "references", "examples"), { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), "line\n".repeat(121));
      await writeFile(path.join(skillDir, "references", "at-budget.md"), "line\n".repeat(200));
      await writeFile(path.join(skillDir, "references", "over.md"), "line\n".repeat(201));
      await writeFile(path.join(skillDir, "references", "examples", "long.md"), "line\n".repeat(900));
      expect(budgetProblems(skillDir)).toEqual([
        "SKILL.md has 121 lines, over 120",
        "references/over.md has 201 lines, over 200",
      ]);
    } finally {
      await removeTempDir(skillDir);
    }
  });
});

// Each rule in scenario-rules.md shows the weak form, the strong form, and
// what enforces it. A `Checked by:` line names finding codes, which must
// exist, or says review: a rule that names a code nukadoko does not report
// promises a check nobody runs.
const registeredCodes: ReadonlySet<string> = new Set([...listCheckCodes().map((entry) => entry.code), ...TEND_CODES]);

function ruleShapeProblems(text: string): string[] {
  const problems: string[] = [];
  const sections = text.split(/^(?=## )/m).filter((section) => /^## S\d/.test(section));
  sections.forEach((section, index) => {
    const heading = /^## (S\d+)\. /.exec(section);
    const id = heading?.[1] ?? section.split("\n")[0]!;
    if (id !== `S${index + 1}`) problems.push(`${id} is not numbered S${index + 1}`);
    for (const label of ["Bad:", "Good:", "Checked by:"]) {
      if (!new RegExp(`^${label}`, "m").test(section)) problems.push(`${id} has no ${label} line`);
    }
    const checkedBy = /^Checked by:([\s\S]*?)(?:\n\n|$)/m.exec(section)?.[1] ?? "";
    const codes = [...checkedBy.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((match) => match[1]!);
    for (const code of codes) {
      if (!registeredCodes.has(code)) problems.push(`${id} names \`${code}\`, which is not a check or tend code`);
    }
    if (codes.length === 0 && !/^\s*review\b/.test(checkedBy)) {
      problems.push(`${id}'s Checked by: names no code and does not say review`);
    }
  });
  if (sections.length === 0) problems.push("no rule sections");
  return problems;
}

describe("scenario-rules.md rule shape", () => {
  it("gives every rule a Bad:, a Good:, and a Checked by: line that names real codes or review", async () => {
    const text = await readFile(path.join(skillsDir, "acceptance", "references", "scenario-rules.md"), "utf8");
    expect(ruleShapeProblems(text)).toEqual([]);
    expect(text.match(/^## S\d+\. /gm)).toHaveLength(12);
  });

  it("names a missing line, an unknown code, a bare Checked by:, and a numbering gap", () => {
    const text = [
      "# Rules",
      "",
      "## S1. one",
      "",
      "Bad: x",
      "Checked by: `then-mutates` and `then-reads-nothing`.",
      "",
      "## S3. two",
      "",
      "Bad: x",
      "Good: y",
      "Checked by: a person.",
      "",
    ].join("\n");
    expect(ruleShapeProblems(text)).toEqual([
      "S1 has no Good: line",
      "S1 names `then-reads-nothing`, which is not a check or tend code",
      "S3 is not numbered S2",
      "S3's Checked by: names no code and does not say review",
    ]);
  });
});
