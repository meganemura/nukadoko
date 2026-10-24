import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { stepTemplate } from "../src/cli/scaffold.js";
import { claimsProblem } from "../src/step/claims.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir, repoRoot, withoutCheckNotes } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `nuka scaffold <name> --pattern <text> [--then]`. The
// file it writes has to pass `nuka check` against a feature line as
// written, and with `--then` it is a claim step that runs green once
// observe returns the value it reads.

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

  it("writes the pattern, one args field per capture, and with --then observe and a claim in place of run", async () => {
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
        "  // TODO: read the value this line checks and return it as { actual }, or take it",
        "  // from an earlier step's returns through `from` and remove observe.",
        "  observe() {",
        '    throw new Error("not implemented: sum-is");',
        "  },",
        '  claims: [{ actual: "actual", compare: "equal", expected: "sum" }],',
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
        '  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
        "  // returns: z.object({ ... }),",
        "  run({}, { n, f, w, s, a, d, b, c }) {",
        '    throw new Error(`not implemented: set-values; args ${JSON.stringify({ n, f, w, s, a, d, b, c }, (_key, value) => (typeof value === "bigint" ? String(value) : value))}`);',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["if", "when {if:string} happens"],
    ["await", "wait {await:string}"],
    ["null", "got {null:string}"],
  ])("refuses a capture named %s, a reserved word, and writes nothing", async (key, pattern) => {
    const result = await cli(rootDir, ["scaffold", "when-reserved", "--pattern", pattern]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`the pattern captures "${key}", a reserved word`);
    expect(result.stderr).toContain("which does not parse");
    expect(existsSync(path.join(rootDir, "features", "steps", "when-reserved.ts"))).toBe(false);
  });

  it("names every reserved capture when the pattern has more than one", async () => {
    const result = await cli(rootDir, ["scaffold", "when-reserved", "--pattern", "when {if:string} meets {class:string}"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('the pattern captures "if", "class", reserved words');
    expect(existsSync(path.join(rootDir, "features", "steps", "when-reserved.ts"))).toBe(false);
  });

  it.each([
    ["an unnamed capture", "a {string}", 'Parameter "{string}" has no name'],
    ["a key captured twice", "from {x:int} to {x:int}", 'the pattern captures "x" more than once'],
    ["an empty optional", "a () b", "An optional must contain some text."],
    ["an unterminated capture", "a {x:int", "{x:int"],
    ["an empty pattern", "", "the pattern is empty"],
  ])("refuses %s and writes nothing", async (_label, pattern, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", "--pattern", pattern]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to scaffold: ");
    expect(result.stderr).toContain(message);
    expect(existsSync(path.join(rootDir, "features", "steps", "broken.ts"))).toBe(false);
  });

  it.each([
    ["--pattern -", ["--pattern", "-"], '  pattern: "-",\n'],
    ["--pattern=-", ["--pattern=-"], '  pattern: "-",\n'],
    ["--pattern -x", ["--pattern", "-x"], '  pattern: "-x",\n'],
    ["--pattern --then", ["--pattern", "--then"], '  pattern: "--then",\n'],
    ["--pattern='-'", ["--pattern='-'"], '  pattern: "\'-\'",\n'],
    ["--description - a dash", ["--pattern", "a", "--description", "- a dash"], '  description: "- a dash",\n'],
  ])("takes a value that starts with a dash, quotes kept, through %s", async (_label, flags, line) => {
    const result = await cli(rootDir, ["scaffold", "dash", ...flags]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "dash.ts"), "utf8")).toContain(line);
  });

  it.each([["--pattern"], ["--description"]])("refuses %s given no value, and names only that", async (flag) => {
    const result = await cli(rootDir, ["scaffold", "dash", flag]);

    expect(result.stderr).toBe(
      `refused\tinvalid-arguments\t-\tNot enough arguments following: ${flag.slice(2)}\n  fix: Correct the command line; the command's --help lists its flags.\n  do: nuka scaffold --help\n`,
    );
    expect(result.exitCode).toBe(2);
    expect(existsSync(path.join(rootDir, "features", "steps", "dash.ts"))).toBe(false);
  });

  it("refuses a capture typed number, lists the registered types, and names int and float", async () => {
    const result = await cli(rootDir, ["scaffold", "run-sum", "--pattern", "I add {a:number} and {b:number}"]);

    expect(result.stderr).toBe(
      `refused\tinvalid-value\t-\tRefusing to scaffold: the pattern names type "number", and this project registers none by that name; registered types: ${BUILTIN_TYPES}; did you mean {a:int} or {a:float}?\n  fix: Correct the flag's value as the message says.\n  do: nuka scaffold --help\n`,
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
    expect(existsSync(path.join(rootDir, "features", "steps", "run-sum.ts"))).toBe(false);
  });

  it("refuses a type the project does not register, and writes it as z.unknown() once the config registers it", async () => {
    const refused = await cli(rootDir, ["scaffold", "wait-for", "--pattern", "I wait {d:duration}"]);
    expect(refused.stderr).toBe(
      `refused\tinvalid-value\t-\tRefusing to scaffold: the pattern names type "duration", and this project registers none by that name; registered types: ${BUILTIN_TYPES}\n  fix: Correct the flag's value as the message says.\n  do: nuka scaffold --help\n`,
    );
    expect(refused.exitCode).toBe(2);
    expect(existsSync(path.join(rootDir, "features", "steps", "wait-for.ts"))).toBe(false);

    await registerTypes(rootDir, ["duration"]);
    const written = await cli(rootDir, ["scaffold", "wait-for", "--pattern", "I wait {d:duration}"]);
    expect(written.stderr).toBe("");
    expect(written.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "wait-for.ts"), "utf8")).toContain("    d: z.unknown(),\n");

    // A second unknown type is still refused, with the project's type in the list.
    const second = await cli(rootDir, ["scaffold", "paint", "--pattern", "paint it {c:colour}"]);
    expect(second.stderr).toBe(
      'refused\tinvalid-value\t-\tRefusing to scaffold: the pattern names type "colour", and this project registers none by that name; registered types: bigdecimal, biginteger, byte, double, duration, float, int, long, short, string, word\n' +
        "  fix: Correct the flag's value as the message says.\n  do: nuka scaffold --help\n",
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
    expect(result.exitCode).toBe(2);
    expect(existsSync(path.join(rootDir, "features", "steps", "run-sum.ts"))).toBe(false);
  });

  it("passes nuka check against the feature as written, fails until implemented, and runs green once observe returns the value", async () => {
    await cli(rootDir, ["scaffold", "add-numbers", "--pattern", "I add {a:int} and {b:int}"]);
    await cli(rootDir, ["scaffold", "sum-is", "--pattern", "the sum is {sum:int}", "--then"]);
    await writeFile(
      path.join(rootDir, "features", "sum.feature"),
      ["Feature: sum", "  Scenario: two and two", "    When I add 2 and 2", "    Then the sum is 4", ""].join("\n"),
    );

    const check = await cli(rootDir, ["check"]);
    expect(withoutCheckNotes(check.stdout + check.stderr)).toBe("");
    expect(check.exitCode).toBe(0);

    const unimplemented = await cli(rootDir, ["run", "--records", "features/sum.feature"]);
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
      (await readFile(sumIs, "utf8")).replace('throw new Error("not implemented: sum-is");', "return { actual: 4 };"),
    );

    const green = await cli(rootDir, ["run", "--records", "features/sum.feature"]);
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
            expect(scaffold.stderr).toMatch(/^refused\tinvalid-value\t-\tRefusing to scaffold: the pattern names type "[a-z]+", and this project registers none by that name; registered types: /);
            expect(scaffold.exitCode).toBe(2);
            expect(existsSync(filePath)).toBe(false);
            return;
          }
          expect(scaffold.stderr).toBe("");
          expect(scaffold.exitCode).toBe(0);
          const check = await cli(rootDir, ["check", "--json"]);
          const codes = [...bySeverity(check.stdout).errors, ...bySeverity(check.stdout).warnings].map(
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
      "-",
      "--",
      "-x",
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
          expect(withoutCheckNotes(check.stdout + check.stderr)).toBe("");
        } finally {
          await rm(filePath, { force: true });
        }
      },
      { testCases: 40, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

// Property: the claim `--then` writes is one defineStep accepts, whatever
// the capture and chained keys are called, so the stub fails at observe's
// TODO and never at import, and its expected value is never one observe
// computes. A key named like observe's own key ("actual")
// is the case an example would miss.
describe("nuka scaffold --then: the claim it writes", () => {
  const keyNames = ["want", "actual", "actual2", "expected", "got", "stdout"] as const;
  const types = ["string", "int", "biginteger", "colour"] as const;
  const classes = ["string", "number", "bigint", "other"] as const;

  it("is a claim defineStep accepts, whatever the keys are called", () =>
    hegel.test((tc) => {
      const keys = tc.draw(gs.sets(gs.sampledFrom(keyNames), { minSize: 0, maxSize: 4 }));
      const ordered = [...keys];
      const captureCount = tc.draw(gs.integers({ minValue: 0, maxValue: ordered.length }));
      const captureKeys = ordered.slice(0, captureCount);
      const chainedKeys = ordered.slice(captureCount);
      const captures = captureKeys.map((key) => ({ key, type: tc.draw(gs.sampledFrom(types)) }));
      // A line with no capture states its value with a word, or gets no stub.
      const pattern = ["it is", ...captures.map((capture) => `{${capture.key}:${capture.type}}`), ...(captures.length === 0 ? ["empty"] : [])].join(" ");
      const file = stepTemplate({
        name: "it-is",
        pattern,
        captures,
        chained: chainedKeys.map((key) => ({
          key,
          producers: [{ step: "producer", identifier: "producer", specifier: "./producer.ts" }],
          valueClass: tc.draw(gs.sampledFrom(classes)),
        })),
        variant: "then",
        entryPoint: null,
        cwd: null,
        description: null,
        relativeFilePath: "features/steps/it-is.ts",
      });
      expect(file).not.toContain("run(");
      expect(file).not.toContain("mutates");
      const claimsLine = file.split("\n").find((line) => line.startsWith("  claims: "));
      expect(claimsLine).toBeDefined();
      expect(claimsLine).not.toContain("observe");
      const claims = new Function(`return ${claimsLine!.slice("  claims: ".length).replace(/,$/, "")};`)() as unknown;
      const all = new Set([...captureKeys, ...chainedKeys]);
      expect(
        claimsProblem(claims, {
          patterns: [pattern],
          argsKeys: all,
          requiredArgsKeys: all,
          fromKeys: new Set(chainedKeys),
          captureKeys: new Set(captureKeys),
          hasObserve: file.includes("  observe("),
          rewrittenArgs: new Map(),
          stringArgs: null,
        }),
      ).toBeNull();
    }));
});
