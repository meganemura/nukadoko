import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExpression } from "../src/binding/expression.js";
import { createParameterTypeRegistry } from "../src/binding/registry.js";
import { runCli } from "../src/cli/run-cli.js";
import { inferPattern, nameCaptures, redoCommand, stepNameFor } from "../src/cli/scaffold-feature.js";
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
      stderr:
        "next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:\n" +
        "  nuka scaffold a-config-file-with --pattern 'a config file with {value:string}' --replace\n" +
        "  nuka scaffold i-run-greet-with-times --pattern 'I run greet with {value:string} {value2:int} times' --replace\n" +
        "  nuka scaffold the-output-is --pattern 'the output is {value:string}' --then --replace\n" +
        "  nuka scaffold the-exit-code-is --pattern 'the exit code is {value:int}' --then --replace\n",
    });
    expect(await cli(rootDir, ["check", feature])).toEqual({ exitCode: 0, stdout: "ok: no issues found\n", stderr: "" });
  });

  // A claim's expected value is one the line states (docs/spec.md
  // "Claims"): a Then line that states none gets no stub, and one that
  // states its value with a word compares with that word's literal.
  it("writes no stub for a Then line that states no value, and a literal claim for one a word states", async () => {
    const feature = await writeFeature(rootDir, "banner.feature", [
      "Feature: banner",
      "  Scenario: a banner",
      "    When I open the page",
      "    Then the banner looks right",
      "    And the error list is empty",
    ]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(["features/steps/i-open-the-page.ts", "features/steps/the-error-list-is-empty.ts", ""].join("\n"));
    expect(result.stderr).toContain(
      "note: features/banner.feature:4: a Then step's claim compares what the step reads with a value the line states, and this pattern captures none and holds no word that states one (no, none, nothing, empty), so no stub was written; state the value this line checks in the line, such as a number or a quoted text, and scaffold again\n",
    );
    expect(existsSync(path.join(rootDir, "features", "steps", "the-banner-looks-right.ts"))).toBe(false);
    expect(await stepFile(rootDir, "the-error-list-is-empty")).toContain('  claims: [{ actual: "actual", compare: "equal", expected: { literal: "" } }],');
  });

  it("writes a When stub with its captures, and a Then stub with observe and a claim", async () => {
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
        '  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
        "  // returns: z.object({ ... }),",
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
        "",
        "export default defineStep({",
        '  description: "TODO: describe the-exit-code-is",',
        '  pattern: "the exit code is {value:int}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    value: z.number(),",
        "  }),",
        "  // TODO: read the value this line checks and return it as { actual }, or take it",
        "  // from an earlier step's returns through `from` and remove observe.",
        "  observe() {",
        '    throw new Error("not implemented: the-exit-code-is");',
        "  },",
        '  claims: [{ actual: "actual", compare: "equal", expected: "value" }],',
        "});",
        "",
      ].join("\n"),
    );
  });

  it("gives a docstring line a string key and a table line a rows key, the expected value of a Then", async () => {
    const feature = await writeFeature(rootDir, "body.feature", [
      "Feature: body",
      "  Scenario: a body and a table",
      "    When I send this body",
      '      """',
      '      {"name":"lamp"}',
      '      """',
      "    Then the headers are",
      "      | content-type | application/json |",
    ]);

    const result = await cli(rootDir, ["scaffold", "--feature", feature]);

    expect(result.exitCode).toBe(0);
    expect(await stepFile(rootDir, "i-send-this-body")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe i-send-this-body",',
        '  pattern: "I send this body",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    docstring: z.string(),",
        "  }),",
        "  // Return what later steps cite and the values this step's correctness rests on;",
        '  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
        "  // returns: z.object({ ... }),",
        "  run({}, { docstring }) {",
        "    throw new Error(`not implemented: i-send-this-body; args ${JSON.stringify({ docstring })}`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    expect(await stepFile(rootDir, "the-headers-are")).toContain(
      ["  args: z.object({", "    table: z.array(z.array(z.string())),", "  }),"].join("\n"),
    );
    expect(await stepFile(rootDir, "the-headers-are")).toContain('  claims: [{ actual: "actual", compare: "equal", expected: "table" }],');
    expect(await cli(rootDir, ["check", feature])).toEqual({ exitCode: 0, stdout: "ok: no issues found\n", stderr: "" });
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
      stdout: "warning\tscenario-without-then\tfeatures/add.feature:2\tScenario \"one\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  fix: Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.\nwarning\tscenario-without-then\tfeatures/add.feature:4\tScenario \"two\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  fix: Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.\n",
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
        'note: features/cart.feature:3: "3 items in (the) cart" reads as "{int} items in \\\\(the) cart" or "{count} items in \\\\(the) cart" or "{float} items in \\\\(the) cart", so the stub\'s pattern is the line as written, with no capture; put a {key:type} capture in it by hand\n' +
        "next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:\n" +
        "  nuka scaffold 3-items-in-the-cart --pattern '3 items in \\(the) cart' --replace\n",
    });
    expect(await stepFile(rootDir, "3-items-in-the-cart")).toContain('  pattern: "3 items in \\\\(the) cart",\n  // Give');
    expect(await cli(rootDir, ["check", feature])).toEqual({
      exitCode: 0,
      stdout: "warning\tscenario-without-then\tfeatures/cart.feature:2\tScenario \"one\" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  fix: Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.\n",
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
        'note: features/apples.feature:3: "I have {value:int} apples" would also match "I have 5 apples" (features/other.feature:3), so the stub\'s pattern is the line as written, with no capture\n' +
        "next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:\n" +
        "  nuka scaffold i-have-3-apples --pattern 'I have 3 apples' --replace\n",
    });
    expect((await cli(rootDir, ["check"])).exitCode).toBe(0);
  });

  it("prints, for each stub, a single scaffold that writes the same bytes again", async () => {
    const feature = await writeFeature(rootDir, "greet.feature", GREET);
    const { stderr } = await cli(rootDir, ["scaffold", "--feature", feature]);
    const thenLine = stderr.split("\n").find((line) => line.includes("the-output-is"))!;
    const before = await stepFile(rootDir, "the-output-is");

    const redone = await cli(rootDir, ["scaffold", "the-output-is", "--pattern", "the output is {value:string}", "--then", "--replace"]);

    expect(thenLine).toBe("  nuka scaffold the-output-is --pattern 'the output is {value:string}' --then --replace");
    expect(redone).toEqual({ exitCode: 0, stdout: "features/steps/the-output-is.ts\n", stderr: "" });
    expect(await stepFile(rootDir, "the-output-is")).toBe(before);
  });

  it("prints no line for a stub that the single scaffold would write differently", async () => {
    // Outside featuresDir, so the single scaffold reads no line with a docstring.
    await writeFile(
      path.join(rootDir, "probe.feature"),
      'Feature: probe\n  Scenario: one\n    When I send\n      """\n      hi\n      """\n    Then it answers "ok"\n',
    );

    const result = await cli(rootDir, ["scaffold", "--feature", "probe.feature"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "features/steps/i-send.ts\nfeatures/steps/it-answers.ts\n",
      stderr:
        "next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:\n" +
        "  nuka scaffold it-answers --pattern 'it answers {value:string}' --then --replace\n",
    });
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
      exitCode: 2,
      stdout: "",
      stderr:
        "refused\tstep-file-import-failed\t-\tRefusing to scaffold: 1 step file(s) did not import, so which lines are undefined is not known (a line may belong to a step in one of them)\n" +
        "  fix: Correct the import or the error that the message names in the file, then run nuka check again.\n  do: nuka check\n",
    });
    expect(existsSync(path.join(rootDir, "features", "steps", "the-output-is.ts"))).toBe(false);
  });

  it("names a feature file that does not exist", async () => {
    const result = await cli(rootDir, ["scaffold", "--feature", "features/nope.feature"]);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "refused\ttarget-not-found\t-\tnuka scaffold --feature: feature file not found: features/nope.feature\n" +
        "  fix: Name a file or a directory that exists.\n" +
        "  do: nuka scaffold --help\n",
    });
  });

  it("refuses a step name or a per-step option beside --feature", async () => {
    const result = await cli(rootDir, ["scaffold", "greet", "--then", "--feature", "features/greet.feature"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      "refused\tinvalid-arguments\t-\t--feature names each stub and reads its pattern and outcome from its own line; leave out a step name, --then, or scaffold that step on its own with nuka scaffold <name>\n" +
        "  fix: Correct the command line; the command's --help lists its flags.\n" +
        "  do: nuka scaffold --help\n",
    );
  });

  it("names --feature when neither a name nor --feature is given", async () => {
    const result = await cli(rootDir, ["scaffold"]);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "refused\tinvalid-arguments\t-\tMissing required argument: name (or --feature <path>)\n" +
        "  fix: Correct the command line; the command's --help lists its flags.\n" +
        "  do: nuka scaffold --help\n",
    });
  });

  it("names the scaffold command as undefined-step's do", async () => {
    const feature = await writeFeature(rootDir, "greet.feature", ["Feature: greet", "  Scenario: one", "    When nothing defines this"]);

    const result = await cli(rootDir, ["check", feature]);

    expect(result.stdout).toContain(
      'error\tundefined-step\tfeatures/greet.feature:3\tNo step definition matches "nothing defines this"\n' +
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

describe("redoCommand", () => {
  it("reads back, under sh, as the single scaffold of that stub with --replace", () =>
    hegel.test((tc) => {
      const pattern = inferPattern(featureLine(tc), createParameterTypeRegistry()).pattern;
      const name = stepNameFor(pattern);
      const then = tc.draw(gs.booleans());
      const result = spawnSync("sh", ["-c", `printf '%s\\0' ${redoCommand(name, pattern, then)}`], { encoding: "utf8" });
      expect(result.stdout.split("\0").slice(0, -1)).toEqual([
        "nuka",
        "scaffold",
        name,
        "--pattern",
        pattern,
        ...(then ? ["--then"] : []),
        "--replace",
      ]);
    }));
});
