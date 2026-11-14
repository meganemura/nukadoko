import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { DIRECTIVE, guardLines, referencesPlaywright, shiftMappings } from "../scripts/guard-playwright-types.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: the build step that lets the shipped declarations compile
// without the optional `playwright` peer. Whether a consumer's `tsc` passes
// is covered end to end in optional-playwright.test.ts; this file holds the
// invariants of the rewrite itself, and checks them against the `dist/` this
// test run built.

const REFERENCES = [
  'import type { Page } from "playwright";',
  "import type * as Playwright from 'playwright';",
  '} from "playwright";',
  'export type { Page } from "playwright/test";',
  '    readonly page: import("playwright").Page;',
  'import "playwright";',
];

const OTHER_LINES = [
  'import type { Step } from "./step.js";',
  'import type { Core } from "playwright-core";',
  'import type { Local } from "./playwright.js";',
  'export declare const SPECIFIER = "playwright";',
  "// needs playwright",
  "",
  DIRECTIVE,
];

const line = gs.oneOf(
  gs.sampledFrom(REFERENCES),
  gs.sampledFrom(OTHER_LINES),
  gs.text({ maxSize: 20, alphabet: "abc {}();:=.*/ " }),
);
const indented = gs.tuples(gs.sampledFrom(["", "  ", "\t"]), line).map(([indent, text]) => `${indent}${text}`);
const declaration = gs.arrays(indented, { maxSize: 12 });

function withoutInserted(lines: readonly string[], insertedBefore: readonly number[]): string[] {
  const inserted = new Set(insertedBefore.map((index, order) => index + order));
  return lines.filter((_, index) => !inserted.has(index));
}

describe("referencesPlaywright", () => {
  it("matches a module specifier and nothing that only mentions the name", () => {
    expect(REFERENCES.map(referencesPlaywright)).toEqual(REFERENCES.map(() => true));
    expect(OTHER_LINES.map(referencesPlaywright)).toEqual(OTHER_LINES.map(() => false));
  });
});

describe("guardLines", () => {
  it("leaves every reference preceded by the directive", () =>
    hegel.test((tc) => {
      const { lines } = guardLines(tc.draw(declaration));
      lines.forEach((text, index) => {
        if (referencesPlaywright(text)) expect(lines[index - 1]?.trim()).toBe(DIRECTIVE);
      });
    }));

  it("only inserts directive lines, at the reported places", () =>
    hegel.test((tc) => {
      const input = tc.draw(declaration);
      const { lines, insertedBefore } = guardLines(input);
      expect(lines.length).toBe(input.length + insertedBefore.length);
      expect(withoutInserted(lines, insertedBefore)).toEqual(input);
      insertedBefore.forEach((index, order) => {
        expect(lines[index + order]?.trim()).toBe(DIRECTIVE);
      });
    }));

  it("changes nothing on a second pass", () =>
    hegel.test((tc) => {
      const once = guardLines(tc.draw(declaration)).lines;
      const twice = guardLines(once);
      expect(twice.insertedBefore).toEqual([]);
      expect(twice.lines).toEqual(once);
    }));
});

describe("shiftMappings", () => {
  const segments = gs.text({ maxSize: 12, alphabet: "ACDEFGIKMOQSgkm," });

  it("moves every generated line down by the lines inserted before it", () =>
    hegel.test((tc) => {
      const original = tc.draw(gs.arrays(segments, { minSize: 1, maxSize: 10 }));
      const before = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: original.length - 1 }), { maxSize: 5 }));
      const insertedBefore = [...new Set(before)].sort((a, b) => a - b);
      const shifted = shiftMappings(original.join(";"), insertedBefore).split(";");
      expect(shifted.length).toBe(original.length + insertedBefore.length);
      original.forEach((text, index) => {
        const offset = insertedBefore.filter((at) => at <= index).length;
        expect(shifted[index + offset]).toBe(text);
      });
      insertedBefore.forEach((index, order) => {
        expect(shifted[index + order]).toBe("");
      });
    }));
});

describe("the built dist/", () => {
  it("has the directive before every declaration line that names playwright", async () => {
    const dist = path.join(repoRoot, "dist");
    const files = (await readdir(dist, { recursive: true })).filter((file) => file.endsWith(".d.ts"));
    const unguarded: string[] = [];
    let references = 0;
    for (const file of files) {
      const lines = (await readFile(path.join(dist, file), "utf8")).split("\n");
      lines.forEach((text, index) => {
        if (!referencesPlaywright(text)) return;
        references += 1;
        if (lines[index - 1]?.trim() !== DIRECTIVE) unguarded.push(`${file}:${index + 1}`);
      });
    }
    expect(unguarded).toEqual([]);
    expect(references).toBeGreaterThan(0);
  });
});
