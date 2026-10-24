import { readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { listAllCheckCodes } from "../src/cli/check.js";
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
import { parseFindings } from "../src/finding/finding.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the two code tables in llms.txt are equal to the two
// registries, so a code added, removed, or reworded fails here until
// `npm run build && node scripts/llms-codes.ts` rewrites the file; and the
// generator's table rendering and marker splicing hold for any text.

const llms = readFileSync(path.join(repoRoot, "llms.txt"), "utf8");
const regenerate = "run `npm run build && node scripts/llms-codes.ts`";

describe("llms.txt code tables", () => {
  it("lists every code nuka check --codes prints with its severity, description, and fix", () => {
    const rows = parseTable(readGenerated(llms, checkTable([]).marker));
    const expected = listAllCheckCodes().map((entry) => [`\`${entry.code}\``, entry.severity, entry.message, entry.fix!]);
    expect(rows, regenerate).toEqual(expected);
  });

  it("lists every nuka tend code with its description and fix", () => {
    const rows = parseTable(readGenerated(llms, tendTable([]).marker));
    const expected = listTendCodes().map((entry) => [`\`${entry.code}\``, entry.description, entry.fix]);
    expect(rows, regenerate).toEqual(expected);
  });

  it("gives every code one registry: no code is both a check, run, or refusal code and listed twice", () => {
    const codes = listAllCheckCodes().map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    const tend = new Set<string>(listTendCodes().map((entry) => entry.code));
    expect(codes.filter((code) => tend.has(code))).toEqual([]);
  });
});

describe("nuka tend --codes", () => {
  it("prints one note finding per code, code ascending, before any project loads", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--codes"], { rootDir: fixture("invalid-config-project"), stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const findings = parseFindings(stdout.text());
    expect(findings).toHaveLength(9);
    expect(findings[0]).toEqual({
      severity: "note",
      code: "fixture-unused",
      where: "-",
      message: "No typed step requires a config.fixtures definition, directly or through another fixture.",
      fix: "Remove the fixture from config.fixtures, or keep it for nuka do.",
    });
    expect(stdout.text()).toContain(
      "note\tschema-field-undescribed\t-\tA field of a typed step's args or returns schema has no .describe(), so an agent choosing a step cannot read what it means.\n" +
        "  fix: Add a .describe() that says what the field means to each field that the message names.\n",
    );
  });

  it("--json prints the envelope, then one entry per code", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--codes", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const document = JSON.parse(stdout.text()) as { schema_version: number; codes: Array<{ code: string }> };
    expect(Object.keys(document)).toEqual(["schema_version", "nukadoko", "command", "verdict", "findings", "codes"]);
    expect(document).toMatchObject({ schema_version: 2, command: "tend", verdict: "passed", findings: [] });
    const entries = document.codes;
    expect(entries).toHaveLength(9);
    expect(entries.find((entry) => entry.code === "pattern-unbound")).toEqual({
      severity: "note",
      code: "pattern-unbound",
      message: "A typed step has a pattern, and no feature line resolves to that step alone.",
      fix: "Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
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
    const tend = listTendCodes().map((entry) => ({ code: entry.code, severity: "note", message: entry.description, fix: entry.fix }));
    const check = listAllCheckCodes().map((entry) => ({ code: entry.code, severity: entry.severity, message: entry.message, fix: entry.fix! }));
    expect(rewrite(llms, [checkTable(check), tendTable(tend)])).toBe(llms);
  });

  it("refuses a file without the block instead of writing nothing", () => {
    expect(() => spliceGenerated("# nukadoko\n", "<!-- generated: t -->", "x")).toThrow(
      'llms.txt has no "<!-- generated: t -->" ... "<!-- /generated -->" block',
    );
  });
});
