import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/check/analyze.js";
import { findScenarioShapeFindings, parseFeatureSource } from "../src/feature/load-features.js";
import { createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

const STEP = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the word is {word:string}",',
  '  description: "A word the scenario names.",',
  "  args: z.object({ word: z.string() }),",
  "  returns: z.object({}),",
  "  mutates: false,",
  "  run() {",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

const FEATURE = [
  "Feature: shapes",
  "",
  "  Scenario: no outcome",
  '    Given the word is "a"',
  '    When the word is "b"',
  "",
  "  Scenario: an And under Then",
  '    When the word is "a"',
  '    Then the word is "b"',
  '    And the word is "c"',
  "",
  "  Scenario: only stars",
  '    * the word is "a"',
  "",
  "  Scenario Outline: words",
  '    Then the word is "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "      | b    |",
  "",
  "  Scenario Outline: word <word>",
  '    Then the word is "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "      | b    |",
  "",
  "  Scenario Outline: one word",
  '    Then the word is "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "",
].join("\n");

describe("nuka check: scenario-without-then and outline-rows-share-name", () => {
  let rootDir: string;

  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(path.join(rootDir, "features", "steps", "word.ts"), STEP);
    await writeFile(path.join(rootDir, "features", "shapes.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("warns on a scenario with no Then and on an outline whose rows share its name, and on nothing else", async () => {
    const report = await analyzeProject(rootDir);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      {
        code: "scenario-without-then",
        message:
          'Scenario "no outcome" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.',
        file: "features/shapes.feature",
        line: 3,
        fix: "Add a Then line that checks the outcome the scenario is for.",
      },
      {
        code: "outline-rows-share-name",
        message:
          'Scenario outline "words" has 2 Examples rows, and its name uses none of the columns (<word>), so every row is reported under the same name.',
        file: "features/shapes.feature",
        line: 15,
        fix: "Add a column to the name, such as: words <word>",
      },
    ]);
  });
});

const KEYWORDS = ["Given", "When", "Then", "And", "But", "*"] as const;

/** Whether a scenario of these keywords, under a Background of those, has no
 * Then position anywhere and a Given or When position among its own steps,
 * reading And and But as the keyword before them. */
function lacksThen(background: readonly string[], keywords: readonly string[]): boolean {
  let position = "*";
  const positions = [...background, ...keywords].map((keyword) => {
    position = keyword === "And" || keyword === "But" ? position : keyword;
    return position;
  });
  const own = positions.slice(background.length);
  return !positions.includes("Then") && own.some((p) => p === "Given" || p === "When");
}

describe("findScenarioShapeFindings", () => {
  it("warns once for each scenario with no Then position, under the Background too, and some Given or When of its own", () =>
    hegel.test((tc) => {
      const background = tc.draw(gs.arrays(gs.sampledFrom(KEYWORDS), { maxSize: 3 }));
      const scenarios = tc.draw(
        gs.arrays(gs.arrays(gs.sampledFrom(KEYWORDS), { maxSize: 5 }), { minSize: 1, maxSize: 4 }),
      );
      const source = [
        "Feature: generated",
        ...(background.length > 0
          ? ["  Background:", ...background.map((keyword, step) => `    ${keyword} background ${step}`)]
          : []),
        ...scenarios.flatMap((keywords, index) => [
          `  Scenario: s${index}`,
          ...keywords.map((keyword, step) => `    ${keyword} step ${step}`),
        ]),
        "",
      ].join("\n");
      const { gherkinDocument } = parseFeatureSource(source, "features/generated.feature");

      const warned = findScenarioShapeFindings(gherkinDocument, "features/generated.feature")
        .filter((finding) => finding.code === "scenario-without-then")
        .map((finding) => finding.name);

      expect(warned).toEqual(
        scenarios.flatMap((keywords, index) => (lacksThen(background, keywords) ? [`s${index}`] : [])),
      );
    }));
});
