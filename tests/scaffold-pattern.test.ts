import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { stepTemplate } from "../src/cli/scaffold.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir, repoRoot } from "./helpers/fixtures.js";

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

const BUILTIN_TYPES = "bigdecimal, biginteger, byte, double, float, int, long, short, string, word";

/** Replaces the project's config with one that registers these types. */
async function registerTypes(rootDir: string, names: readonly string[]): Promise<void> {
  const entries = names.map((name) => `{ name: ${JSON.stringify(name)}, regexp: /[a-z]+/ }`).join(", ");
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    `import { defineConfig } from "nukadoko";\n\nexport default defineConfig({ parameterTypes: [${entries}] });\n`,
  );
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
        'import assert from "node:assert/strict";',
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
        "    // TODO: read the value this line checks, for example from an earlier step's returns through `from`.",
        "    const actual: unknown = undefined;",
        "    assert.equal(actual, sum, `sum: expected ${JSON.stringify(sum)}, got ${JSON.stringify(actual)}`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("gives each built-in capture type the schema of the value it produces, and a custom type z.unknown()", async () => {
    await registerTypes(rootDir, ["colour"]);
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

  it("refuses a capture typed number, lists the registered types, and names int and float", async () => {
    const result = await cli(rootDir, ["scaffold", "run-sum", "--pattern", "I add {a:number} and {b:number}"]);

    expect(result.stderr).toBe(
      `Refusing to scaffold: the pattern names type "number", and this project registers none by that name; registered types: ${BUILTIN_TYPES}; did you mean {a:int} or {a:float}?\ndo: nuka scaffold --help\n`,
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
    expect(existsSync(path.join(rootDir, "features", "steps", "run-sum.ts"))).toBe(false);
  });

  it("refuses a type the project does not register, and writes it as z.unknown() once the config registers it", async () => {
    const refused = await cli(rootDir, ["scaffold", "wait-for", "--pattern", "I wait {d:duration}"]);
    expect(refused.stderr).toBe(
      `Refusing to scaffold: the pattern names type "duration", and this project registers none by that name; registered types: ${BUILTIN_TYPES}\ndo: nuka scaffold --help\n`,
    );
    expect(refused.exitCode).toBe(1);
    expect(existsSync(path.join(rootDir, "features", "steps", "wait-for.ts"))).toBe(false);

    await registerTypes(rootDir, ["duration"]);
    const written = await cli(rootDir, ["scaffold", "wait-for", "--pattern", "I wait {d:duration}"]);
    expect(written.stderr).toBe("");
    expect(written.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "wait-for.ts"), "utf8")).toContain("    d: z.unknown(),\n");

    // A second unknown type is still refused, with the project's type in the list.
    const second = await cli(rootDir, ["scaffold", "paint", "--pattern", "paint it {c:colour}"]);
    expect(second.stderr).toBe(
      'Refusing to scaffold: the pattern names type "colour", and this project registers none by that name; registered types: bigdecimal, biginteger, byte, double, duration, float, int, long, short, string, word\ndo: nuka scaffold --help\n',
    );
  });

  it("counts a compat defineParameterType in the steps directory as registered", async () => {
    // A relative import of this checkout's compat entry: the bare
    // "nukadoko/compat" resolves to dist/ from a project nested in this
    // repository, a module instance discovery from src/ does not share.
    const stepsDir = path.join(rootDir, "features", "steps");
    const compat = path.relative(stepsDir, path.join(repoRoot, "src", "compat", "index.js")).split(path.sep).join("/");
    await writeFile(
      path.join(stepsDir, "glue.ts"),
      `import { defineParameterType } from ${JSON.stringify(compat)};\n\ndefineParameterType({ name: "shout", regexp: /[A-Z]+/ });\n`,
    );

    const result = await cli(rootDir, ["scaffold", "say", "--pattern", "I say {word:shout}"]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "say.ts"), "utf8")).toContain("    word: z.unknown(),\n");
  });

  it("reports a config that fails to load, not the type, when the pattern needs the project's types", async () => {
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({ typo: 1 });\n');

    const result = await cli(rootDir, ["scaffold", "run-sum", "--pattern", "I add {a:number}"]);

    expect(result.stderr).toContain("typo");
    expect(result.stderr).not.toContain("Refusing to scaffold");
    expect(result.exitCode).toBe(1);
    expect(existsSync(path.join(rootDir, "features", "steps", "run-sum.ts"))).toBe(false);
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
        "const actual: unknown = undefined;",
        "const actual: unknown = 4;",
      ),
    );

    const green = await cli(rootDir, ["run", "features/sum.feature"]);
    expect(green.stderr).toContain("1 scenario: 1 passed, 0 failed");
    expect(green.exitCode).toBe(0);
  });
});

// Property: a capture whose type the project registers, a built-in or one
// of its own, is written, and `nuka check` reports no unknown type for the
// file; a capture whose type it does not register is refused with nothing
// written. Type names are drawn from both sets and from arbitrary words.
describe("nuka scaffold --pattern: any capture type", () => {
  let rootDir: string;
  let counter = 0;
  const builtins = BUILTIN_TYPES.split(", ");
  const registered = ["colour", "duration"];
  const known = gs.sampledFrom([...builtins, ...registered]);

  beforeAll(async () => {
    rootDir = await initProject();
    await registerTypes(rootDir, registered);
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a step check accepts iff every captured type is registered", () =>
    hegel.testAsync(
      async (tc) => {
        const types = tc.draw(
          gs.arrays(
            // A known name three times as often as a random word, so both outcomes are common.
            gs.oneOf(known, known, known, gs.text({ minSize: 1, maxSize: 8, alphabet: "abcdenrtu" })),
            { minSize: 1, maxSize: 3 },
          ),
        );
        const words = tc.draw(gs.arrays(gs.sampledFrom(["set", "the", "to", "and"]), { minSize: types.length, maxSize: types.length }));
        const pattern = types.map((type, index) => `${words[index]} {k${index}:${type}}`).join(" ");
        const expected = types.every((type) => builtins.includes(type) || registered.includes(type));
        counter += 1;
        const name = `typed-${counter}`;
        const filePath = path.join(rootDir, "features", "steps", `${name}.ts`);
        try {
          const scaffold = await cli(rootDir, ["scaffold", name, "--pattern", pattern]);
          if (!expected) {
            expect(scaffold.stderr).toMatch(/^Refusing to scaffold: the pattern names type "[a-z]+", and this project registers none by that name; registered types: /);
            expect(scaffold.exitCode).toBe(1);
            expect(existsSync(filePath)).toBe(false);
            return;
          }
          expect(scaffold.stderr).toBe("");
          expect(scaffold.exitCode).toBe(0);
          const check = await cli(rootDir, ["check", "--json"]);
          const codes = [...JSON.parse(check.stdout).errors, ...JSON.parse(check.stdout).warnings].map(
            (issue: { code: string }) => issue.code,
          );
          expect(codes).not.toContain("unknown-parameter-type");
        } finally {
          await rm(filePath, { force: true });
        }
      },
      { testCases: 30, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
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

  // Each of the 40 cases runs up to three commands, and a failing case is
  // shrunk through many more, so the suite's one-test budget is too small.
  // It gets the budget the property above has for the same commands. Hegel's
  // TooSlow health check fails a property with few valid inputs after 30
  // seconds, and a loaded machine had produced only 4 by then, so it is off
  // here as it is above.
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
      { testCases: 40, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

// Property: the Then body that `--then` writes for one capture runs for any
// value the capture and the chained value can hold, a bigint included, and
// its message names both values; a custom type compares by structure.
describe("nuka scaffold --then: the assertion body", () => {
  const CLASS_OF_TYPE = { string: "string", int: "number", biginteger: "bigint", colour: "other" } as const;
  type CaptureType = keyof typeof CLASS_OF_TYPE;
  type ValueClass = (typeof CLASS_OF_TYPE)[CaptureType];

  function valueOf(valueClass: ValueClass) {
    if (valueClass === "string") return gs.text();
    if (valueClass === "number") return gs.integers();
    if (valueClass === "bigint") return gs.bigIntegers();
    return gs.oneOf<unknown>(gs.text(), gs.integers(), gs.bigIntegers(), gs.arrays(gs.bigIntegers(), { maxSize: 3 }));
  }

  // A bigint capture reads as its digits; any other value as JSON, a bigint inside it as a string.
  function rendered(value: unknown, valueClass: ValueClass): string {
    if (valueClass === "bigint") return String(value);
    return String(JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? String(inner) : inner)));
  }

  it("calls assert once with the actual value, the expected value, and a message that names both", () =>
    hegel.test((tc) => {
      const type = tc.draw(gs.sampledFrom(Object.keys(CLASS_OF_TYPE) as CaptureType[]));
      const chainedClass = tc.draw(gs.optional(gs.sampledFrom<ValueClass>(["string", "number", "bigint", "other"])));
      const expected = tc.draw(valueOf(CLASS_OF_TYPE[type]));
      const got = chainedClass === null ? undefined : tc.draw(valueOf(chainedClass));
      const file = stepTemplate({
        name: "it-is",
        pattern: `it is {want:${type}}`,
        captures: [{ key: "want", type }],
        chained:
          chainedClass === null
            ? []
            : [{ step: "producer", key: "got", identifier: "producer", specifier: "./producer.ts", valueClass: chainedClass }],
        variant: "then",
        entryPoint: null,
        description: null,
        relativeFilePath: "features/steps/it-is.ts",
      });
      expect(file).toContain('\nimport assert from "node:assert/strict";\n');
      const lines = file.split("\n");
      const body = lines
        .slice(lines.findIndex((line) => line.startsWith("  run(")) + 1, lines.lastIndexOf("  },"))
        .join("\n")
        .replace("const actual: unknown =", "const actual =");
      const calls: unknown[][] = [];
      const recorder = {
        equal: (...args: unknown[]) => calls.push(["equal", ...args]),
        deepEqual: (...args: unknown[]) => calls.push(["deepEqual", ...args]),
      };
      new Function("assert", "want", "got", body)(recorder, expected, got);
      expect(calls).toEqual([
        [type === "colour" ? "deepEqual" : "equal", got, expected, `want: expected ${rendered(expected, CLASS_OF_TYPE[type])}, got ${rendered(got, chainedClass ?? CLASS_OF_TYPE[type])}`],
      ]);
    }));
});
