import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { importIdentifiers, importSpecifier, parseFromFlag } from "../src/cli/scaffold.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  removeTempDir,
  repoRoot,
  testsDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --from <step>.<key>`. The file it
// writes chains a key of an earlier step's `returns` into this step's
// args: it has to import, pass `nuka check` against a scenario that binds
// the producer first, show the `from` entry in `nuka describe`, and type
// check under the project's own `tsc`.

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

const RUN_GREET = [
  'import { defineStep, z } from "nukadoko";',
  "",
  "export default defineStep({",
  '  description: "runs greet",',
  '  pattern: "I run greet with {name:string}",',
  "  args: z.object({ name: z.string() }),",
  '  returns: z.object({ exitCode: z.number(), stdout: z.string().describe("what greet printed") }),',
  "  run({}, { name }) {",
  "    return { exitCode: 0, stdout: `Hello, ${name}!` };",
  "  },",
  "});",
  "",
].join("\n");

const MAKE_DIR = [
  'import { defineStep, z } from "nukadoko";',
  "",
  "export default defineStep({",
  '  description: "makes a directory",',
  '  pattern: "a scratch directory",',
  "  args: z.object({}),",
  "  returns: z.object({ cwd: z.string() }),",
  "  run() {",
  '    return { cwd: "/tmp/greet" };',
  "  },",
  "});",
  "",
].join("\n");

describe("nuka scaffold --from", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
    await writeFile(path.join(rootDir, "features", "steps", "run-greet.ts"), RUN_GREET);
    await writeFile(path.join(rootDir, "features", "steps", "make-dir.ts"), MAKE_DIR);
    await writeFile(
      path.join(rootDir, "features", "steps", "list-names.ts"),
      'import { defineStep, z } from "nukadoko";\nexport default defineStep({ description: "lists", args: z.object({}), returns: z.array(z.string()), run() { return []; } });\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes the import, the args field from the producer's schema, the from entry, and the key in run", async () => {
    const result = await cli(rootDir, [
      "scaffold",
      "output-says",
      "--pattern",
      "the output says {text:string}",
      "--then",
      "--from",
      "run-greet.stdout",
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "output-says.ts"), "utf8")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        'import runGreet from "./run-greet.js";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe output-says",',
        '  pattern: "the output says {text:string}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    text: z.string(),",
        "    stdout: runGreet.returns.shape.stdout,",
        "  }),",
        "  from: {",
        '    stdout: [runGreet, "stdout"],',
        "  },",
        "  mutates: false,",
        "  run({}, { text, stdout }) {",
        '    throw new Error("not implemented: output-says");',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("imports each producer once for two --from, in the order given", async () => {
    const result = await cli(rootDir, [
      "scaffold",
      "greet-wrote",
      "--then",
      "--from",
      "run-greet.stdout",
      "--from",
      "make-dir.cwd",
      "--from",
      "run-greet.exitCode",
    ]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "features", "steps", "greet-wrote.ts"), "utf8")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        'import runGreet from "./run-greet.js";',
        'import makeDir from "./make-dir.js";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe greet-wrote",',
        '  // pattern: "the feature line this step matches", (without one, the step is called by name only)',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    stdout: runGreet.returns.shape.stdout,",
        "    cwd: makeDir.returns.shape.cwd,",
        "    exitCode: runGreet.returns.shape.exitCode,",
        "  }),",
        "  from: {",
        '    stdout: [runGreet, "stdout"],',
        '    cwd: [makeDir, "cwd"],',
        '    exitCode: [runGreet, "exitCode"],',
        "  },",
        "  mutates: false,",
        "  run({}, { stdout, cwd, exitCode }) {",
        '    throw new Error("not implemented: greet-wrote");',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it.each([
    [["--from", "run-greet.stdot"], 'run-greet does not return "stdot"; its keys are exitCode, stdout'],
    [["--from", "make-dir.stdout"], 'make-dir does not return "stdout"; its keys are cwd'],
    [["--from", "list-names.length"], "list-names's returns is not a z.object, so it has no key to chain"],
    [["--from", "no-such-step.stdout"], 'no typed step is named "no-such-step" (`nuka steps` lists the vocabulary)'],
    [["--from", "run-greet"], '--from takes <step>.<key>, a step name and one identifier that is not a reserved word, and got "run-greet"'],
    [["--from", "run-greet.std-out"], '--from takes <step>.<key>, a step name and one identifier that is not a reserved word, and got "run-greet.std-out"'],
    [["--from", "run-greet.delete"], '--from takes <step>.<key>, a step name and one identifier that is not a reserved word, and got "run-greet.delete"'],
    [["--pattern", "says {stdout:string}", "--from", "run-greet.stdout"], 'args key "stdout" is filled twice'],
    [["--from", "run-greet.stdout", "--from", "run-greet.stdout"], 'args key "stdout" is filled twice'],
  ])("refuses %j and writes nothing", async (flags, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", "--then", ...flags]);

    expect(result.stderr).toContain(`Refusing to scaffold: ${message}`);
    expect(result.exitCode).toBe(1);
    expect(existsSync(path.join(rootDir, "features", "steps", "broken.ts"))).toBe(false);
  });

  it("passes nuka check, shows the from entry in describe, runs green once implemented, and type checks", async () => {
    await cli(rootDir, [
      "scaffold",
      "output-says",
      "--pattern",
      "the output says {text:string}",
      "--then",
      "--from",
      "run-greet.stdout",
    ]);
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      [
        "Feature: greet",
        "  Scenario: greet a name",
        '    When I run greet with "Ada"',
        '    Then the output says "Hello, Ada!"',
        "",
      ].join("\n"),
    );

    const check = await cli(rootDir, ["check"]);
    expect(check.stdout + check.stderr).toBe("ok: no issues found\n");

    const described = await cli(rootDir, ["describe", "output-says"]);
    expect(JSON.parse(described.stdout).from).toEqual({ stdout: "run-greet.stdout" });
    expect(JSON.stringify(JSON.parse(described.stdout).args)).toContain("what greet printed");

    const outputSays = path.join(rootDir, "features", "steps", "output-says.ts");
    await writeFile(
      outputSays,
      (await readFile(outputSays, "utf8")).replace(
        'throw new Error("not implemented: output-says");',
        "if (stdout !== text) throw new Error(`expected ${text}, got ${stdout}`);",
      ),
    );
    const green = await cli(rootDir, ["run", "features/greet.feature"]);
    expect(green.stderr).toContain("1 scenario: 1 passed, 0 failed");
    expect(green.exitCode).toBe(0);

    const typecheck = await typecheckSteps({
      "run-greet.ts": RUN_GREET,
      "output-says.ts": await readFile(outputSays, "utf8"),
    });
    expect(typecheck.output).toBe("");
    expect(typecheck.code).toBe(0);
  });
});

const execFileAsync = promisify(execFile);

/** Compiles step files against the built package, the types a project
 * sees, under NodeNext: the resolution the `.js` import specifier is
 * written for. */
async function typecheckSteps(files: Record<string, string>): Promise<{ code: number; output: string }> {
  // Under tests/ so "nukadoko" resolves to this package by its own name.
  const parent = path.join(testsDir, ".tmp-fixtures");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "scaffold-from-types-"));
  try {
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ESNext"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["**/*.ts"],
      }),
    );
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, name), text);
    }
    const { stdout } = await execFileAsync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", dir]);
    return { code: 0, output: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? 1, output: failed.stdout ?? "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Property: for any producer whose `returns` is an object schema, and any
// key of it, the chained step imports (`nuka check` reports no issue, so
// discovery loaded it and the `from` entry validated) and `nuka describe`
// shows the from entry naming that producer and key.
describe("nuka scaffold --from: any producer key", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a step that check accepts and describe shows chained", () =>
    hegel.testAsync(
      async (tc) => {
                // A leading "k" keeps every key clear of the reserved words scaffold refuses.
        const keys = [...tc.draw(gs.sets(gs.fromRegex("k[a-zA-Z0-9_$]{0,7}"), { minSize: 1, maxSize: 5 }))];
        const key = tc.draw(gs.sampledFrom(keys));
        counter += 1;
        const producer = tc.draw(gs.fromRegex("[a-z0-9]{1,4}(-[a-z0-9]{1,4}){0,2}")) + `-p${counter}`;
        const consumer = `consumer-${counter}`;
        const stepsDir = path.join(rootDir, "features", "steps");
        const fields = keys.map((name) => `${JSON.stringify(name)}: z.string()`).join(", ");
        await writeFile(
          path.join(stepsDir, `${producer}.ts`),
          `import { defineStep, z } from "nukadoko";\nexport default defineStep({ description: "p", args: z.object({}), returns: z.object({ ${fields} }), run() { throw new Error("unused"); } });\n`,
        );
        try {
          const scaffold = await cli(rootDir, ["scaffold", consumer, "--then", "--from", `${producer}.${key}`]);
          expect(scaffold.stderr).toBe("");
          expect(scaffold.exitCode).toBe(0);
          const check = await cli(rootDir, ["check"]);
          expect(check.stdout + check.stderr).toBe("ok: no issues found\n");
          const described = await cli(rootDir, ["describe", consumer]);
          expect(JSON.parse(described.stdout).from).toEqual({ [key]: `${producer}.${key}` });
        } finally {
          await rm(path.join(stepsDir, `${producer}.ts`), { force: true });
          await rm(path.join(stepsDir, `${consumer}.ts`), { force: true });
        }
      },
      // Each case runs scaffold, check, and describe, and each of them
      // loads every step file, so a case is slow by design and a loaded
      // machine must not fail it on time alone.
      { testCases: 15, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

describe("scaffold --from helpers", () => {
  it("parses <step>.<key>, and refuses a reserved-word key or a value with no key", () =>
    hegel.test((tc) => {
      const step = tc.draw(gs.fromRegex("[a-z0-9-]{1,8}"));
      const key = tc.draw(gs.oneOf(gs.fromRegex("[a-zA-Z_$][a-zA-Z0-9_$]{0,7}"), gs.sampledFrom(["do", "in", "delete", "default", "await", "yield", "eval", "arguments", "package", "enum"])));
      const parsed = parseFromFlag(`${step}.${key}`);
      let reserved = false;
      try {
        // Strict mode inside an async function: the rules a step module's
        // own `run` parameters are parsed under.
        new Function(`"use strict"; async function f() { const { ${key} } = {}; }`);
      } catch {
        reserved = true;
      }
      expect(parsed).toEqual(reserved ? { refusal: expect.stringContaining(JSON.stringify(`${step}.${key}`)) } : { step, key });
      expect("refusal" in parseFromFlag(step)).toBe(true);
    }));

  it("names each distinct step with a distinct identifier that is legal and shadows nothing", () =>
    hegel.test((tc) => {
      const names = tc.draw(
        gs.arrays(gs.oneOf(gs.fromRegex("[a-z0-9-]{1,8}"), gs.sampledFrom(["z", "define-step", "delete", "2fa", "-", "a--b", "a-b"])), {
          minSize: 1,
          maxSize: 8,
        }),
      );
      const identifiers = importIdentifiers(names);
      expect(new Set(identifiers.keys())).toEqual(new Set(names));
      const values = [...identifiers.values()];
      expect(new Set(values).size).toBe(values.length);
      for (const identifier of values) {
        expect(identifier).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
        expect(() => new Function(`let ${identifier} = 1; return ${identifier};`)).not.toThrow();
        expect(["z", "defineStep"]).not.toContain(identifier);
      }
    }));

  it("camel-cases a kebab name as a person would write it", () => {
    expect([...importIdentifiers(["run-greet", "z", "2fa-login", "delete"]).values()]).toEqual([
      "runGreet",
      "zStep",
      "step2faLogin",
      "deleteStep",
    ]);
  });

  it("imports a sibling .ts as .js, an .mts as .mjs, and a nested file by its relative path", () => {
    expect(importSpecifier("/p/features/steps", "/p/features/steps/run-greet.ts")).toBe("./run-greet.js");
    expect(importSpecifier("/p/features/steps", "/p/features/steps/run-greet.mts")).toBe("./run-greet.mjs");
    expect(importSpecifier("/p/features/steps", "/p/features/steps/cli/run.ts")).toBe("./cli/run.js");
    expect(importSpecifier("/p/features/steps", "/p/features/shared/run.ts")).toBe("../shared/run.js");
  });
});
