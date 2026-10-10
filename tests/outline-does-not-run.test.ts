import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/check/analyze.js";
import { createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an outline whose Examples rows will not run is an error
// from `nuka check` before a run. A filled outline and a plain scenario
// stay silent. The rows are not generated here.

const STEP = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the list includes {item:string}",',
  '  description: "A list entry the feature names.",',
  "  args: z.object({ item: z.string() }),",
  "  returns: z.object({ item: z.string() }),",
  "  mutates: false,",
  "  run({}, args) {",
  "    return { item: args.item };",
  "  },",
  "});",
  "",
].join("\n");

const FEATURE = [
  "Feature: Boundaries",
  "",
  "  Scenario: a plain case",
  '    Given the list includes "milk"',
  "",
  "  Scenario Outline: a filled outline",
  '    Given the list includes "<item>"',
  "    Examples:",
  "      | item |",
  "      | milk |",
  "",
  "  Scenario Outline: an outline with no examples",
  '    Given the list includes "<item>"',
  "",
  "  Scenario Outline: an outline with a header and no rows",
  '    Given the list includes "<item>"',
  "    Examples:",
  "      | item |",
  "",
  "  Scenario: a scenario whose examples have no rows",
  '    Given the list includes "milk"',
  "    Examples:",
  "      | item |",
  "",
].join("\n");

const CONFIG = ['import { defineConfig } from "nukadoko";', "", "export default defineConfig({});", ""].join("\n");

describe("outline-does-not-run", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports an outline with no Examples table and a table with no rows", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await mkdir(path.join(rootDir, "features/steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(path.join(rootDir, "features/steps/includes.ts"), STEP);
    await writeFile(path.join(rootDir, "features/boundaries.feature"), FEATURE);

    const report = await analyzeProject(rootDir);
    const issues = report.errors.filter((issue) => issue.code === "outline-does-not-run");
    expect(issues.map((issue) => ({ line: issue.line, message: issue.message }))).toEqual([
      {
        line: 12,
        message:
          'Scenario outline "an outline with no examples" has no Examples table, so the placeholder text runs as written. Add one Examples row for each boundary that must run.',
      },
      {
        line: 17,
        message:
          'Scenario "an outline with a header and no rows" has an Examples table with no rows, so the scenario is left out of the run. Add a row, or remove the table.',
      },
      {
        line: 22,
        message:
          'Scenario "a scenario whose examples have no rows" has an Examples table with no rows, so the scenario is left out of the run. Add a row, or remove the table.',
      },
    ]);
    expect(report.errors.filter((issue) => issue.code === "undefined-step")).toEqual([]);
  });
});
