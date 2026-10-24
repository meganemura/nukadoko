import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/check/analyze.js";
import { findScenarioShapeFindings, parseFeatureSource } from "../src/feature/load-features.js";
import { createEmptyTempDir, ensureNukadokoShim, removeTempDir, repoRoot } from "./helpers/fixtures.js";

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

// The Then lines bind a claim step: a step that runs belongs in a Given or
// a When (docs/spec.md "Claims").
const CLAIM_STEP = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the word should be {word:string}",',
  '  description: "A word the scenario expects.",',
  "  args: z.object({ word: z.string() }),",
  "  observe() {",
  '    return { seen: "a" };',
  "  },",
  '  claims: [{ actual: "seen", compare: "equal", expected: "word" }],',
  "});",
  "",
].join("\n");

// A compat step bound in Then position judges by throwing, which nukadoko
// cannot see. A relative import of this checkout's compat entry: the bare
// "nukadoko/compat" resolves to dist/ from a project nested in this
// repository, a module instance discovery from src/ does not share.
function compatStep(stepsDir: string): string {
  const compat = path.relative(stepsDir, path.join(repoRoot, "src", "compat", "index.js")).split(path.sep).join("/");
  return [`import { Then } from "${compat}";`, 'Then("the word was seen", function () {});', ""].join("\n");
}

const FEATURE = [
  "Feature: shapes",
  "",
  "  Scenario: no outcome",
  '    Given the word is "a"',
  '    When the word is "b"',
  "",
  "  Scenario: an And under Then",
  '    When the word is "a"',
  '    Then the word should be "b"',
  '    And the word should be "c"',
  "",
  "  Scenario: only stars",
  '    * the word is "a"',
  "",
  "  Scenario Outline: words",
  '    Then the word should be "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "      | b    |",
  "",
  "  Scenario Outline: word <word>",
  '    Then the word should be "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "      | b    |",
  "",
  "  Scenario Outline: one word",
  '    Then the word should be "<word>"',
  "    Examples:",
  "      | word |",
  "      | a    |",
  "",
  "  Scenario: a compat Then",
  '    When the word is "a"',
  "    Then the word was seen",
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
    await writeFile(path.join(rootDir, "features", "steps", "word-should-be.ts"), CLAIM_STEP);
    await writeFile(path.join(rootDir, "features", "steps", "word-was-seen.ts"), compatStep(path.join(rootDir, "features", "steps")));
    await writeFile(path.join(rootDir, "features", "shapes.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("warns on each scenario that judges no claim and on an outline whose rows share its name, and on nothing else", async () => {
    const report = await analyzeProject(rootDir);
    const fix = "Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.";

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      {
        code: "scenario-without-then",
        message:
          'Scenario "no outcome" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.',
        file: "features/shapes.feature",
        line: 3,
        fix,
      },
      {
        code: "scenario-without-then",
        message:
          'Scenario "only stars" has only * lines, so no line is in Then position and no claim is judged: it passes whenever its steps run without an error.',
        file: "features/shapes.feature",
        line: 12,
        fix,
      },
      {
        code: "outline-rows-share-name",
        message:
          'Scenario outline "words" has 2 Examples rows, and its name uses none of the columns (<word>), so every row is reported under the same name.',
        file: "features/shapes.feature",
        line: 15,
        fix: "Add a column to the name, such as: words <word>",
      },
      {
        code: "then-compat-step",
        message:
          'Step "compat: the word was seen" is a compat step bound in Then position. A compat step cannot declare claims, so nukadoko cannot see what it judges; this is a static coverage gap, not something the tool caught at run time (docs/spec.md "Compat steps", "Claims")',
        file: "features/shapes.feature",
        line: 37,
        step: "compat: the word was seen",
        fix: "Move the step to defineStep with claims, or move the line out of Then position.",
      },
      {
        code: "scenario-without-then",
        message:
          'Scenario "a compat Then" judges no claim: none of its Then lines binds a claim step, so it passes whenever its steps run without an error. A compat step in Then position judges by throwing or not, and nukadoko cannot see what it checked.',
        file: "features/shapes.feature",
        line: 37,
        fix,
      },
    ]);
  });
});

const KEYWORDS = ["Given", "When", "Then", "And", "But", "*"] as const;

/** Whether a scenario of these keywords, under a Background of those, has
 * steps of its own and no Then position anywhere, reading And and But as
 * the keyword before them. */
function lacksThen(background: readonly string[], keywords: readonly string[]): boolean {
  let position = "*";
  const positions = [...background, ...keywords].map((keyword) => {
    position = keyword === "And" || keyword === "But" ? position : keyword;
    return position;
  });
  return keywords.length > 0 && !positions.includes("Then");
}

describe("findScenarioShapeFindings", () => {
  it("warns once for each scenario with steps of its own and no Then position, under the Background too", () =>
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
