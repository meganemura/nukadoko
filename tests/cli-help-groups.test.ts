import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it, vi } from "vitest";
import { type HelpLine, renderCommandGroups } from "../src/cli/help-groups.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka --help` lists the everyday loop first, under group
// headings, and a command's own `--help` still carries its description.
// The grouped list is rendered by hand (yargs cannot group commands), so the
// renderer's own properties are tested here too.

async function help(argv: readonly string[]): Promise<string> {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.join(" "));
  });
  try {
    const exitCode = await runCli([...argv, "--help"], {
      rootDir: repoRoot,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return logged.join("\n");
}

describe("nuka --help", () => {
  it("groups the commands, everyday loop first", async () => {
    const text = await help([]);
    const outline = text
      .split("\n")
      .filter((line) => /^\S.*:$/.test(line) || /^ {2}nuka /.test(line))
      .map((line) => (line.startsWith("  nuka ") ? line.trim().split(/\s+/)[1] : line));
    expect(outline).toEqual([
      "Everyday:",
      "init",
      "scaffold",
      "check",
      "run",
      "steps",
      "describe",
      "Exploring:",
      "do",
      "session",
      "Upkeep:",
      "tend",
      "clean",
      "skill",
      "Experimental:",
      "experimental",
      "Options:",
    ]);
  });

  it("keeps a grouped command's own description on its own help screen", async () => {
    const text = await help(["init"]);
    expect(text.split("\n").slice(0, 3)).toEqual(["nuka init", "", "set up a project; ends with a self-check"]);
  });

  it("lists explore, mcp-tools, and webmcp-tools under experimental", async () => {
    const text = await help(["experimental"]);
    expect(text).toContain("  nuka experimental explore <file> ");
    expect(text).toContain("  nuka experimental mcp-tools ");
    expect(text).toContain("  nuka experimental webmcp-tools <url> ");
  });
});

const word = gs.text({ minSize: 1, maxSize: 10, alphabet: "abcdefghij`<>.-" });
const line: gs.Generator<HelpLine> = gs
  .tuples(gs.arrays(word, { minSize: 1, maxSize: 3 }), gs.arrays(word, { minSize: 0, maxSize: 30 }))
  .map(([usage, describe]) => ({ usage: usage.join(" "), describe: describe.join(" ") }));
const groups = gs.arrays(
  gs.tuples(gs.text({ minSize: 1, maxSize: 12, alphabet: "ABCabc" }), gs.arrays(line, { minSize: 1, maxSize: 5 })),
  { minSize: 1, maxSize: 4 },
);

// Reads a rendered list back into headings and lines, joining each
// description's continuation lines, so the property below compares the
// structure rather than the layout.
function readBack(text: string): { heading: string; lines: HelpLine[] }[] {
  const rows = text.split("\n");
  const column = Math.max(...rows.filter((row) => row.startsWith("  nuka ")).map((row) => /^ {2}nuka .*?( {2,}|$)/.exec(row)![0].length));
  const out: { heading: string; lines: HelpLine[] }[] = [];
  for (const row of rows) {
    if (row === "") continue;
    if (!row.startsWith(" ")) out.push({ heading: row.slice(0, -1), lines: [] });
    else if (row.startsWith("  nuka ")) {
      out.at(-1)!.lines.push({ usage: row.slice(7, column).trim(), describe: row.slice(column).trim() });
    } else {
      const last = out.at(-1)!.lines.at(-1)!;
      out.at(-1)!.lines[out.at(-1)!.lines.length - 1] = { ...last, describe: `${last.describe} ${row.trim()}` };
    }
  }
  return out;
}

describe("renderCommandGroups", () => {
  it("keeps every heading, command, and description, in order, within the width", () => {
    hegel.test((tc) => {
      const drawn = tc.draw(groups).map(([heading, lines]) => ({ heading, lines }));
      const text = renderCommandGroups("nuka", drawn, 80);
      for (const row of text.split("\n")) expect(row.length).toBeLessThanOrEqual(80);
      expect(readBack(text)).toEqual(
        drawn.map((group) => ({
          heading: group.heading,
          lines: group.lines.map((entry) => ({ usage: entry.usage, describe: entry.describe })),
        })),
      );
    });
  });
});
