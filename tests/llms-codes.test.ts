import { readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { listAllCheckCodes } from "../src/cli/check.js";
import { runCli } from "../src/cli/run-cli.js";
import {
  END_MARKER,
  checkTable,
  parseTable,
  readGenerated,
  renderTable,
  rewrite,
  spliceGenerated,
} from "../scripts/llms-codes.js";
import { parseFindings } from "../src/finding/finding.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the code table in llms.txt is equal to the registries
// `nuka check --codes` prints, so a code added, removed, or reworded fails here until
// `npm run build && node scripts/llms-codes.ts` rewrites the file; and the
// generator's table rendering and marker splicing hold for any text.

const llms = readFileSync(path.join(repoRoot, "llms.txt"), "utf8");
const regenerate = "run `npm run build && node scripts/llms-codes.ts`";

describe("llms.txt code table", () => {
  it("lists every code nuka check --codes prints with its severity, description, and fix", () => {
    const rows = parseTable(readGenerated(llms, checkTable([]).marker));
    const expected = listAllCheckCodes().map((entry) => [`\`${entry.code}\``, entry.severity, entry.message, entry.fix!]);
    expect(rows, regenerate).toEqual(expected);
  });

  it("gives every code one registry: no code is listed twice across the check, run, and refusal codes", () => {
    const codes = listAllCheckCodes().map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("nuka check --codes", () => {
  it("lists each note with its severity, before any project loads", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--codes"], { rootDir: fixture("invalid-config-project"), stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const notes = parseFindings(stdout.text()).filter((finding) => finding.severity === "note");
    expect(notes.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "fixture-unused",
        "from-unused",
        "package-type-missing",
        "parameter-type-unused",
        "pattern-unbound",
        "schema-field-undescribed",
        "step-description-todo",
      ]),
    );
    expect(notes.find((finding) => finding.code === "fixture-unused")).toEqual({
      severity: "note",
      code: "fixture-unused",
      where: "-",
      message: "No typed step requires a config.fixtures definition, directly or through another fixture.",
      fix: "Remove the fixture from config.fixtures, or keep it for nuka do.",
    });
  });

  it("--json lists the two secrets keys as warnings", async () => {
    const stdout = createCaptureSink();
    expect(await runCli(["check", "--codes", "--json"], { rootDir: fixture("invalid-config-project"), stdout, stderr: createCaptureSink() })).toBe(0);
    const entries = (JSON.parse(stdout.text()) as { codes: Array<{ code: string; severity: string }> }).codes;
    expect(entries.filter((entry) => entry.code.startsWith("secrets-") && entry.code.endsWith("-unknown"))).toEqual([
      expect.objectContaining({ code: "secrets-public-key-unknown", severity: "warning" }),
      expect.objectContaining({ code: "secrets-redact-key-unknown", severity: "warning" }),
    ]);
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
    const check = listAllCheckCodes().map((entry) => ({ code: entry.code, severity: entry.severity, message: entry.message, fix: entry.fix! }));
    expect(rewrite(llms, [checkTable(check)])).toBe(llms);
  });

  it("refuses a file without the block instead of writing nothing", () => {
    expect(() => spliceGenerated("# nukadoko\n", "<!-- generated: t -->", "x")).toThrow(
      'llms.txt has no "<!-- generated: t -->" ... "<!-- /generated -->" block',
    );
  });
});
