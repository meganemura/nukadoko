import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: enforce the project's no-em-dash-in-prose rule (CLAUDE.md
// "Hard rules") across the surfaces a reader outside this repository
// actually opens: docs/, README.md, README.ja.md, CONTRIBUTING.md, skills/. The rule has
// drifted back three times without a check (README.ja.md, docs/spec.ja.md,
// skills/migration/SKILL.md all needed a later cleanup pass) because a
// prose rule with no test is a rule only as durable as whoever remembers to
// reread it. src/ is excluded because CLAUDE.md itself marks its ~1200
// existing em-dashes as a separate, not-yet-scheduled pass. CHANGELOG.md is
// excluded because its released sections quote text that already shipped;
// rewriting a past release's own words to satisfy a rule adopted later
// would falsify the record rather than improve it.
//
// A fenced code block (```) is excluded: an em-dash inside an example's own
// comment, or inside a block of text a reader copies verbatim (e.g. the
// evaluation prompt in README.md), is not this project's prose. Inline
// code spans (`like this`) are checked, not excluded: nothing in the
// covered files currently puts an em-dash inside one, so exempting them
// would only open an evasion route (wrap the em-dash in backticks to dodge
// the check) without ever excluding real content today.

const EM_DASH = "—";

const targetDirs = ["docs", "skills"];
const targetFiles = ["README.md", "README.ja.md", "CONTRIBUTING.md"];

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

// Strips fenced code blocks before scanning: a line is "inside a fence"
// starting the line after an opening ``` and ending on the line with the
// matching closing ```, so the fence delimiters themselves are never
// scanned either way and can't hide an em-dash that sits on the same line
// as a language tag.
function findEmDashesOutsideFences(content: string): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  let inFence = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.includes(EM_DASH)) {
      violations.push({ line: i + 1, text: line });
    }
  }
  return violations;
}

describe("no em-dash in prose", () => {
  it("finds none in docs/, skills/, README.md, README.ja.md, or CONTRIBUTING.md outside fenced code blocks", async () => {
    const files: string[] = [];
    for (const relDir of targetDirs) {
      files.push(...(await listMarkdownFiles(path.join(repoRoot, relDir))));
    }
    for (const relFile of targetFiles) {
      files.push(path.join(repoRoot, relFile));
    }

    const violations: Violation[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const { line, text } of findEmDashesOutsideFences(content)) {
        violations.push({ file: path.relative(repoRoot, file), line, text });
      }
    }

    const report = violations.map((v) => `${v.file}:${v.line}: ${v.text.trim()}`).join("\n");
    expect(violations, `em-dash found in prose:\n${report}`).toHaveLength(0);
  });
});
