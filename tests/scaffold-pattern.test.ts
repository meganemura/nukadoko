import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --pattern <text> [--then]`. The
// file it writes has to pass `nuka check` against a feature line as
// written, and with `--then` it has to run green once the body only
// asserts, with no `returns` and no `return`.

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

describe("nuka scaffold --pattern", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes the pattern, one args field per capture, and with --then mutates: false and no returns", async () => {
    const result = await cli(rootDir, ["scaffold", "sum-is", "--pattern", "the sum is {sum:int} \\(exactly\\)", "--then"]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "sum-is.ts"), "utf8")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe sum-is",',
        '  pattern: "the sum is {sum:int} \\\\(exactly\\\\)",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    sum: z.number(),",
        "  }),",
        "  mutates: false,",
        "  run({}, { sum }) {",
        "    throw new Error(`not implemented: sum-is; args ${JSON.stringify({ sum })}`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("gives each built-in capture type the schema of the value it produces, and a custom type z.unknown()", async () => {
    const result = await cli(rootDir, [
      "scaffold",
      "set-values",
      "--pattern",
      "set {n:int} {f:float} {w:word} {s:string} {a:} {d:bigdecimal} {b:biginteger} {c:colour}",
    ]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "set-values.ts"), "utf8")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe set-values",',
        '  pattern: "set {n:int} {f:float} {w:word} {s:string} {a:} {d:bigdecimal} {b:biginteger} {c:colour}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    n: z.number(),",
        "    f: z.number(),",
        "    w: z.string(),",
        "    s: z.string(),",
        "    a: z.string(),",
        "    d: z.string(),",
        "    b: z.bigint(),",
        "    c: z.unknown(),",
        "  }),",
        "  // Return what later steps cite and the values this step's correctness rests on;",
        '  // beside an absence (false, 0, ""), return proof the read was valid.',
        "  returns: z.object({}),",
        "  run({}, { n, f, w, s, a, d, b, c }) {",
        '    throw new Error(`not implemented: set-values; args ${JSON.stringify({ n, f, w, s, a, d, b, c }, (_key, value) => (typeof value === "bigint" ? String(value) : value))}`);',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["an unnamed capture", "a {string}", 'Parameter "{string}" has no name'],
    ["a key captured twice", "from {x:int} to {x:int}", 'the pattern captures "x" more than once'],
    ["an empty optional", "a () b", "An optional must contain some text."],
    ["an unterminated capture", "a {x:int", "{x:int"],
    ["an empty pattern", "", "the pattern is empty"],
  ])("refuses %s and writes nothing", async (_label, pattern, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", "--pattern", pattern]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to scaffold: ");
    expect(result.stderr).toContain(message);
    expect(existsSync(path.join(rootDir, "features", "steps", "broken.ts"))).toBe(false);
  });

  it("passes nuka check against the feature as written, fails until implemented, and runs green with an assertion-only body", async () => {
    await cli(rootDir, ["scaffold", "add-numbers", "--pattern", "I add {a:int} and {b:int}"]);
    await cli(rootDir, ["scaffold", "sum-is", "--pattern", "the sum is {sum:int}", "--then"]);
    await writeFile(
      path.join(rootDir, "features", "sum.feature"),
      ["Feature: sum", "  Scenario: two and two", "    When I add 2 and 2", "    Then the sum is 4", ""].join("\n"),
    );

    const check = await cli(rootDir, ["check"]);
    expect(check.stdout + check.stderr).toBe("ok: no issues found\n");
    expect(check.exitCode).toBe(0);

    const unimplemented = await cli(rootDir, ["run", "features/sum.feature"]);
    expect(unimplemented.exitCode).toBe(1);
    expect(unimplemented.stdout).toContain("not implemented: add-numbers");

    const addNumbers = path.join(rootDir, "features", "steps", "add-numbers.ts");
    await writeFile(
      addNumbers,
      (await readFile(addNumbers, "utf8")).replace("throw new Error(`not implemented: add-numbers; args ${JSON.stringify({ a, b })}`);", "return {};"),
    );
    const sumIs = path.join(rootDir, "features", "steps", "sum-is.ts");
    await writeFile(
      sumIs,
      (await readFile(sumIs, "utf8")).replace(
        "throw new Error(`not implemented: sum-is; args ${JSON.stringify({ sum })}`);",
        "if (sum !== 4) throw new Error(`expected 4, got ${sum}`);",
      ),
    );

    const green = await cli(rootDir, ["run", "features/sum.feature"]);
    expect(green.stderr).toContain("1 scenario: 1 passed, 0 failed");
    expect(green.exitCode).toBe(0);
  });
});

// Property: whatever text --pattern is given, scaffold either refuses it
// and writes nothing, or writes a step whose file imports, whose pattern is
// that exact text, and that `nuka check` passes. Escaping is the risk the
// property guards: the text goes into a string literal, and a backslash or
// a quote that survives unescaped either breaks the import or changes the
// pattern. Pieces are drawn from cucumber-expressions syntax and the
// characters a string literal treats specially, plus arbitrary text.
describe("nuka scaffold --pattern: any text", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  const piece = gs.oneOf(
    gs.sampledFrom([
      "the",
      " ",
      "{a:int}",
      "{b:string}",
      "{c:word}",
      "{d:float}",
      "{e:}",
      "{f:biginteger}",
      "(s)",
      "\\(",
      "\\)",
      "/",
      "{",
      "}",
      "{int}",
      "()",
      '"',
      "'",
      "\\",
      "\\\\",
      "${x}",
      "`",
      "\n",
      " ",
      "é",
    ]),
    gs.text({ maxSize: 6 }),
  );

  it("refuses with no file, or writes a step that imports with the exact pattern and passes nuka check", () =>
    hegel.testAsync(
      async (tc) => {
        const pattern = tc.draw(gs.arrays(piece, { minSize: 0, maxSize: 6 })).join("");
        counter += 1;
        const name = `case-${counter}`;
        const filePath = path.join(rootDir, "features", "steps", `${name}.ts`);
        try {
          const scaffold = await cli(rootDir, ["scaffold", name, "--pattern", pattern]);
          if (scaffold.exitCode !== 0) {
            expect(scaffold.stderr).toContain("Refusing to scaffold: ");
            expect(existsSync(filePath)).toBe(false);
            return;
          }
          const steps = await cli(rootDir, ["steps", "--json"]);
          const listed = JSON.parse(steps.stdout).steps.find((step: { name: string }) => step.name === name);
          expect(listed?.patterns).toEqual([pattern]);
          const check = await cli(rootDir, ["check"]);
          expect(check.stdout + check.stderr).toBe("ok: no issues found\n");
        } finally {
          await rm(filePath, { force: true });
        }
      },
      { testCases: 40 },
    ));
});
