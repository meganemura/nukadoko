import { readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { listCheckCodes } from "../src/check/codes.js";
import { runCli } from "../src/cli/run-cli.js";
import { listTendCodes } from "../src/tend/types.js";
import {
  END_MARKER,
  checkTable,
  parseTable,
  readGenerated,
  renderTable,
  rewrite,
  spliceGenerated,
  tendTable,
} from "../scripts/llms-codes.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the two code tables in llms.txt are equal to the two
// registries, so a code added, removed, or reworded fails here until
// `npm run build && node scripts/llms-codes.ts` rewrites the file; and the
// generator's table rendering and marker splicing hold for any text.

const llms = readFileSync(path.join(repoRoot, "llms.txt"), "utf8");
const regenerate = "run `npm run build && node scripts/llms-codes.ts`";

describe("llms.txt code tables", () => {
  it("lists every nuka check code with its severity and description", () => {
    const rows = parseTable(readGenerated(llms, checkTable([]).marker));
    const expected = listCheckCodes().map((entry) => [`\`${entry.code}\``, entry.severity ?? "-", entry.description]);
    expect(rows, regenerate).toEqual(expected);
  });

  it("lists every nuka tend code with when it is reported and its description", () => {
    const rows = parseTable(readGenerated(llms, tendTable([]).marker));
    const expected = listTendCodes().map((entry) => [
      `\`${entry.code}\``,
      entry.reportedByDefault ? "default" : "--all",
      entry.description,
    ]);
    expect(rows, regenerate).toEqual(expected);
  });

  it("names the two tend codes only --all reports", () => {
    const rows = parseTable(readGenerated(llms, tendTable([]).marker));
    expect(rows.filter((row) => row[1] === "--all").map((row) => row[0])).toEqual([
      "`schema-field-undescribed`",
      "`step-rationale-missing`",
    ]);
  });
});

describe("nuka tend --codes", () => {
  it("prints one line per code, code ascending, before any project loads", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--codes"], { rootDir: fixture("invalid-config-project"), stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const lines = stdout.text().trimEnd().split("\n");
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe(
      "additional-feature-dir-missing\tdefault\tAn entry in additionalFeatureDirs does not exist on disk, so nothing under it is scanned.",
    );
    expect(lines.find((line) => line.startsWith("step-rationale-missing\t"))).toBe(
      "step-rationale-missing\t--all\tA typed step has no rationale, so an agent cannot tell why it is built this way before it changes the step.",
    );
  });

  it("--json prints code, description, and reportedByDefault per code", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--codes", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const entries = JSON.parse(stdout.text()) as Array<{ code: string }>;
    expect(entries).toHaveLength(15);
    expect(entries.find((entry) => entry.code === "pattern-unbound")).toEqual({
      code: "pattern-unbound",
      description: "A typed step has a pattern, and no feature line resolves to that step alone.",
      reportedByDefault: true,
    });
  });
});

const cellText = gs.text({ maxSize: 30, alphabet: "ab |\\`-" }).map((text) => text.trim());
const table = gs
  .integers({ minValue: 1, maxValue: 4 })
  .flatMap((width) =>
    gs.tuples(
      gs.arrays(cellText, { minSize: width, maxSize: width }),
      gs.arrays(gs.arrays(cellText, { minSize: width, maxSize: width }), { maxSize: 6 }),
    ),
  );

describe("scripts/llms-codes.ts", () => {
  it("parseTable reads back the rows renderTable wrote, pipes and backslashes included", () =>
    hegel.test((tc) => {
      const [header, rows] = tc.draw(table);
      expect(parseTable(renderTable(header, rows))).toEqual(rows);
    }));

  it("renders a pipe and a backslash escaped", () => {
    expect(renderTable(["A"], [["x | y \\ z"]])).toBe("| A |\n| --- |\n| x \\| y \\\\ z |");
  });

  it("spliceGenerated replaces only the block body, and splicing twice changes nothing more", () =>
    hegel.test((tc) => {
      const marker = "<!-- generated: t -->";
      const before = tc.draw(gs.text({ maxSize: 40, alphabet: "ab\n#" }));
      const old = tc.draw(gs.text({ maxSize: 40, alphabet: "ab\n|" }));
      const after = tc.draw(gs.text({ maxSize: 40, alphabet: "ab\n#" }));
      const body = tc.draw(gs.text({ minSize: 1, maxSize: 40, alphabet: "ab\n|" }));
      const text = `${before}\n${marker}\n${old}\n${END_MARKER}\n${after}`;
      const once = spliceGenerated(text, marker, body);
      expect(once).toBe(`${before}\n${marker}\n${body}\n${END_MARKER}\n${after}`);
      expect(spliceGenerated(once, marker, body)).toBe(once);
      expect(readGenerated(once, marker)).toBe(body);
    }));

  it("rewrite leaves the committed llms.txt as it is", () => {
    expect(rewrite(llms, [checkTable(listCheckCodes()), tendTable(listTendCodes())])).toBe(llms);
  });

  it("refuses a file without the block instead of writing nothing", () => {
    expect(() => spliceGenerated("# nukadoko\n", "<!-- generated: t -->", "x")).toThrow(
      'llms.txt has no "<!-- generated: t -->" ... "<!-- /generated -->" block',
    );
  });
});
