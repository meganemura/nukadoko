import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: enforce the project's rule that a Japanese file holds one
// sentence per line (CLAUDE.md "Hard rules", paired files) across every
// tracked *.ja.md file. The rule drifted without a check: a sweep found
// dozens of lines with two sentences, because a prose rule with no test
// lasts only as long as whoever remembers it.
//
// A line with two or more 。 holds two sentences. A 。 inside a parenthetical
// counts too: the existing files already break such a line after the inner
// 。, so the check holds to that.
//
// A fenced code block (```) is excluded, as in em-dash.test.ts. A table row
// (a line that starts with |) is excluded because Markdown cannot continue
// a row on the next line, so the rule cannot apply there.

const SENTENCE_END = "。";

async function listJapaneseFiles(): Promise<string[]> {
  const files = [path.join(repoRoot, "README.ja.md")];
  const entries = await readdir(path.join(repoRoot, "docs"), { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".ja.md")) files.push(path.join(entry.parentPath, entry.name));
  }
  return files;
}

function findMultiSentenceLines(content: string): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  let inFence = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith("|")) continue;
    if (line.split(SENTENCE_END).length - 1 >= 2) violations.push({ line: i + 1, text: line });
  }
  return violations;
}

describe("one sentence per line in Japanese files", () => {
  it("finds no line with two or more 。 in README.ja.md or docs/**/*.ja.md outside fences and tables", async () => {
    const files = await listJapaneseFiles();
    expect(files.length).toBeGreaterThan(5);

    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const { line, text } of findMultiSentenceLines(content)) {
        violations.push(`${path.relative(repoRoot, file)}:${line}: ${text.trim()}`);
      }
    }

    expect(violations, `lines with two or more sentences:\n${violations.join("\n")}`).toEqual([]);
  });
});
