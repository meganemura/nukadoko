import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExpression } from "../src/binding/expression.js";
import { createParameterTypeRegistry } from "../src/binding/registry.js";
import { runCli } from "../src/cli/run-cli.js";
import { inferPattern, nameCaptures, stepNameFor } from "../src/cli/scaffold-feature.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold --feature <path>`. Each line `nuka check`
// calls undefined gets one stub whose pattern matches it, so `check` is
// green on the feature right after; a reading that is not the only one is
// written as the line itself and named on stderr.

async function initProject(): Promise<string> {
  const rootDir = await createEmptyTempDir();
  await ensureNukadokoShim();
  const initExit = await runCli(["init"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
  if (initExit !== 0) {
    throw new Error("test setup: `nuka init` failed");
  }
  return rootDir;
}

async function cli(rootDir: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

async function writeFeature(rootDir: string, name: string, lines: readonly string[]): Promise<string> {
  const relativePath = path.join("features", name);
  await writeFile(path.join(rootDir, relativePath), `${lines.join("\n")}\n`);
  return relativePath;
}

function stepFile(rootDir: string, name: string): Promise<string> {
  return readFile(path.join(rootDir, "features", "steps", `${name}.ts`), "utf8");
}

const GREET = [
  "Feature: greet",
  "  Scenario: a greeting",
  '    Given a config file with "a=1"',
  '    When I run greet with "Ada" 3 times',
  '    Then the output is "Hello, Ada!"',
  '    And the exit code is 0',
];

describe("nuka scaffold --feature", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes one stub per undefined line, after which check reports nothing for the feature", async () => {
    const feature = await writeFeature(rootDir, "greet.feature", GREET);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "features/steps/a-config-file-with.ts",
        "features/steps/i-run-greet-with-times.ts",
        "features/steps/the-output-is.ts",
        "features/steps/the-exit-code-is.ts",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(await cli(rootDir, ["check", feature])).toEqual({ exitCode: 0, stdout: "ok: no issues found\n", stderr: "" });
  });

  it("writes a When stub with its captures, and a Then stub with mutates: false and an assertion", async () => {
    const feature = await writeFeature(rootDir, "greet.feature", GREET);

    await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(await stepFile(rootDir, "i-run-greet-with-times")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe i-run-greet-with-times",',
        '  pattern: "I run greet with {value:string} {value2:int} times",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    value: z.string(),",
        "    value2: z.number(),",
        "  }),",
        "  // Return what later steps cite and the values this step's correctness rests on;",
        '  // beside an absence (false, 0, ""), return proof the read was valid.',
        "  returns: z.object({}),",
        "  run({}, { value, value2 }) {",
        "    throw new Error(`not implemented: i-run-greet-with-times; args ${JSON.stringify({ value, value2 })}`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    expect(await stepFile(rootDir, "the-exit-code-is")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        'import assert from "node:assert/strict";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe the-exit-code-is",',
        '  pattern: "the exit code is {value:int}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    value: z.number(),",
        "  }),",
        "  mutates: false,",
        "  run({}, { value }) {",
        "    // TODO: read the value this line checks, for example from an earlier step's returns through `from`.",
        "    const actual: unknown = undefined;",
        "    assert.equal(actual, value, `value: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("writes nothing for a line that already matches a step, and nothing on a second run", async () => {
    await cli(rootDir, ["scaffold", "the-output-is", "--pattern", "the output is {text:string}", "--then"]);
    const feature = await writeFeature(rootDir, "greet.feature", GREET);

    const first = await cli(rootDir, ["scaffold", "--feature", feature]);
    const second = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(first.stdout).not.toContain("the-output-is");
    expect(first.stdout.split("\n").filter((line) => line !== "")).toHaveLength(3);
    expect(second).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "nothing to scaffold: every line in features/greet.feature matches a step\n",
    });
  });

  it("gives lines that read as one pattern one file, and a name another step holds a suffix", async () => {
    await cli(rootDir, ["scaffold", "i-add", "--pattern", "I add up everything"]);
    const feature = await writeFeature(rootDir, "add.feature", [
      "Feature: add",
      "  Scenario: one",
      "    When I add 2",
      "  Scenario: two",
      "    When I add 5",
    ]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result.stdout).toBe("features/steps/i-add-2.ts\n");
    // The scenarios have no Then line, so the one warning left is that one.
    expect(await cli(rootDir, ["check", feature])).toEqual({
      exitCode: 0,
      stdout: "warning\tscenario-without-then\tfeatures/add.feature:2\tScenario \"one\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  do: Add a Then line that checks the outcome the scenario is for.\nwarning\tscenario-without-then\tfeatures/add.feature:4\tScenario \"two\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  do: Add a Then line that checks the outcome the scenario is for.\n",
      stderr: "",
    });
  });

  it("writes the line as written, with no capture, when a project type reads the same word, and says so", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({ parameterTypes: [{ name: "count", regexp: /\\d+/ }] });\n',
    );
    const feature = await writeFeature(rootDir, "cart.feature", ["Feature: cart", "  Scenario: one", "    Given 3 items in (the) cart"]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "features/steps/3-items-in-the-cart.ts\n",
      stderr:
        'note: features/cart.feature:3: "3 items in (the) cart" reads as "{int} items in \\\\(the) cart" or "{count} items in \\\\(the) cart" or "{float} items in \\\\(the) cart", so the stub\'s pattern is the line as written, with no capture; put a {key:type} capture in it by hand\n',
    });
    expect(await stepFile(rootDir, "3-items-in-the-cart")).toContain('  pattern: "3 items in \\\\(the) cart",\n  // Give');
    expect(await cli(rootDir, ["check", feature])).toEqual({
      exitCode: 0,
      stdout: "warning\tscenario-without-then\tfeatures/cart.feature:2\tScenario \"one\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  do: Add a Then line that checks the outcome the scenario is for.\n",
      stderr: "",
    });
  });

  it("writes the line as written when its reading would also match another line of the project", async () => {
    await cli(rootDir, ["scaffold", "five-apples", "--pattern", "I have 5 apples"]);
    await writeFeature(rootDir, "other.feature", ["Feature: other", "  Scenario: one", "    Given I have 5 apples"]);
    const feature = await writeFeature(rootDir, "apples.feature", ["Feature: apples", "  Scenario: one", "    Given I have 3 apples"]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "features/steps/i-have-3-apples.ts\n",
      stderr:
        'note: features/apples.feature:3: "I have {value:int} apples" would also match "I have 5 apples" (features/other.feature:3), so the stub\'s pattern is the line as written, with no capture\n',
    });
    expect((await cli(rootDir, ["check"])).exitCode).toBe(0);
  });

  it("writes no file for an outline line whose rows read differently, and says so", async () => {
    const feature = await writeFeature(rootDir, "outline.feature", [
      "Feature: outline",
      "  Scenario Outline: sum",
      "    When I add <n>",
      "    Examples:",
      "      | n   |",
      "      | 2   |",
      "      | 2.5 |",
    ]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr:
        'note: features/outline.feature:3: its Examples rows read as different patterns ("I add {value:int}", "I add {value:float}"), so no stub was written; scaffold it with nuka scaffold <name> --pattern "<line with {key:type} captures>"\n',
    });
    expect(await readdir(path.join(rootDir, "features", "steps"))).toEqual([]);
  });

  it("refuses while a step file does not import, and writes nothing", async () => {
    await writeFile(path.join(rootDir, "features", "steps", "broken.ts"), "throw new Error('boom');\n");
    const feature = await writeFeature(rootDir, "greet.feature", GREET);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Refusing to scaffold: 1 step file(s) did not import, so which lines are undefined is not known (a line may belong to a step in one of them); `nuka check` names them\n",
    });
    expect(existsSync(path.join(rootDir, "features", "steps", "the-output-is.ts"))).toBe(false);
  });

  it("names a feature file that does not exist", async () => {
    const result = await cli(rootDir, ["scaffold", "--feature", "features/nope.feature"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "nuka scaffold --feature: feature file not found: features/nope.feature\n",
    });
  });

  it("refuses a step name or a per-step option beside --feature", async () => {
    const result = await cli(rootDir, ["scaffold", "greet", "--then", "--feature", "features/greet.feature"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "--feature names each stub and reads its pattern and outcome from its own line; leave out a step name, --then, or scaffold that step on its own with nuka scaffold <name>\n",
    );
  });

  it("names --feature when neither a name nor --feature is given", async () => {
    const result = await cli(rootDir, ["scaffold"]);

    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "Missing required argument: name (or --feature <path>)\n" });
  });

  it("puts the command in undefined-step's message", async () => {
    const feature = await writeFeature(rootDir, "greet.feature", ["Feature: greet", "  Scenario: one", "    When nothing defines this"]);

    const result = await cli(rootDir, ["check", feature]);

    expect(result.stdout).toContain(
      'error\tundefined-step\tfeatures/greet.feature:3\tNo step definition matches "nothing defines this"; run `nuka scaffold --feature features/greet.feature` to add one\n' +
        "  do: nuka scaffold --feature features/greet.feature\n",
    );
  });
});

const WORDS = ["I", "run", "the", "greet", "with", "output", "is", "a", "file", "(see)", "x/y", "{brace}", "100%", "back\\slash", "'single'"];

function featureLine(tc: hegel.TestCase): string {
  const parts = tc.draw(
    gs.arrays(
      gs.oneOf(
        gs.sampledFrom(WORDS),
        gs.integers({ minValue: -1000, maxValue: 1000 }).map((value) => String(value)),
        gs.text({ alphabet: "abc XYZ,.!", maxSize: 8 }).map((value) => `"${value}"`),
      ),
      { minSize: 1, maxSize: 8 },
    ),
  );
  return parts.join(" ");
}

describe("inferPattern", () => {
  it("reads any line as a pattern that matches it, under the built-in registry", () =>
    hegel.test((tc) => {
      const registry = createParameterTypeRegistry();
      const text = featureLine(tc);
      const { pattern } = inferPattern(text, registry);
      expect(buildExpression(pattern, registry).expression.match(text)).not.toBeNull();
    }));

  it("names every step it reads in kebab-case, at most 60 characters", () =>
    hegel.test((tc) => {
      const name = stepNameFor(inferPattern(featureLine(tc), createParameterTypeRegistry()).pattern);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(60);
    }));

  it("reads a quoted literal as {string}, an integer as {int}, and a decimal as {float}", () => {
    expect(inferPattern('I pay "Ada" 3 and 2.5', createParameterTypeRegistry())).toEqual({
      kind: "captured",
      pattern: "I pay {value:string} {value2:int} and {value3:float}",
    });
  });

  it("keys each capture and keeps an escaped brace literal", () => {
    expect(nameCaptures("a \\{b} {int} \\\\ {string}")).toBe("a \\{b} {value:int} \\\\ {value2:string}");
  });
});
