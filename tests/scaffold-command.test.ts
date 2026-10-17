import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { relativeJsImports } from "../src/cli/scaffold.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  removeTempDir,
  repoRoot,
  testsDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --command`, the When step that runs
// a program, and the stub every other scaffold writes. The command step has
// to return the three keys a Then step chains with `--from` right after it,
// run a real program, either named on the command line or once its one
// TODO is filled in, refuse to run while the TODO is still there, and every
// scaffolded file has to compile under `noUnusedLocals` and
// `noUnusedParameters`.

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

function stepPath(rootDir: string, name: string): string {
  return path.join(rootDir, "features", "steps", `${name}.ts`);
}

describe("nuka scaffold --command", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes the runCommand body, the three returns keys, and the entry point as the one TODO", async () => {
    const result = await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("features/steps/run-greet.ts\n");
    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "run-greet"), "utf8")).toBe(
      [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        "",
        'const cli = resolve("<TODO: the entry point>");',
        "",
        "export default defineStep({",
        '  description: "Run the command under test in an empty scratch directory",',
        '  pattern: "I run greet with {name:string}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    name: z.string(),",
        "  }),",
        "  returns: z.object({",
        "    exitCode: z.number().nullable(),",
        "    stdout: z.string(),",
        "    stderr: z.string(),",
        "  }),",
        "  async run({ scratch }, { name }) {",
        '    if (cli.includes("<TODO: the entry point>")) throw new Error("fill in the entry point: features/steps/run-greet.ts:4");',
        "    return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("passes a capture that is not a string as its text, and takes no args parameter with no captures", async () => {
    await cli(rootDir, ["scaffold", "run-repeat", "--pattern", "I repeat {word:word} {times:int} times", "--command"]);
    await cli(rootDir, ["scaffold", "run-help", "--command"]);

    expect(await readFile(stepPath(rootDir, "run-repeat"), "utf8")).toContain(
      "    return await runCommand(process.execPath, [cli, word, String(times)], { cwd: scratch.dir() });",
    );
    expect(await readFile(stepPath(rootDir, "run-help"), "utf8")).toBe(
      [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        "",
        'const cli = resolve("<TODO: the entry point>");',
        "",
        "export default defineStep({",
        '  description: "Run the command under test in an empty scratch directory",',
        '  // pattern: "the feature line this step matches", (without one, the step is called by name only)',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({}),",
        "  returns: z.object({",
        "    exitCode: z.number().nullable(),",
        "    stdout: z.string(),",
        "    stderr: z.string(),",
        "  }),",
        "  async run({ scratch }) {",
        '    if (cli.includes("<TODO: the entry point>")) throw new Error("fill in the entry point: features/steps/run-help.ts:4");',
        "    return await runCommand(process.execPath, [cli], { cwd: scratch.dir() });",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it.each([
    [
      ["--command", "--then"],
      "Refusing to scaffold: --command and --then together; a step that runs a program changes state, and a Then step declares mutates: false\n",
    ],
    [
      ["--command", "--pattern", "run {cli:string}"],
      'Refusing to scaffold: args key "cli" would hide a name the written step body reads (cli, runCommand, process, scratch, String, Error); name the capture or the key something else\n',
    ],
    [
      ["--command", "--pattern", "run {Error:string}"],
      'Refusing to scaffold: args key "Error" would hide a name the written step body reads (cli, runCommand, process, scratch, String, Error); name the capture or the key something else\n',
    ],
    [
      ["--command", "src/a.ts", "--command", "src/b.ts"],
      "--command was given more than once.\n",
    ],
    [
      ["--then", "--pattern", "it is {actual:int}"],
      'Refusing to scaffold: args key "actual" would hide a name the written step body reads (Error, JSON, String, assert, actual); name the capture or the key something else\n',
    ],
    [
      ["--pattern", "parse {JSON:string}"],
      'Refusing to scaffold: args key "JSON" would hide a name the written step body reads (Error, JSON, String); name the capture or the key something else\n',
    ],
  ])("refuses %j and writes nothing", async (flags, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", ...flags]);

    expect(result.stderr).toBe(`${message}do: nuka scaffold --help\n`);
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "broken"))).toBe(false);
  });

  it("writes a named entry point in place of the TODO, with no guard", async () => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "cli.ts"), "");
    const result = await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command", "src/cli.ts"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("features/steps/run-greet.ts\n");
    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "run-greet"), "utf8")).toBe(
      [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        "",
        'const cli = resolve("src/cli.ts");',
        "",
        "export default defineStep({",
        '  description: "Run the command under test in an empty scratch directory",',
        '  pattern: "I run greet with {name:string}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    name: z.string(),",
        "  }),",
        "  returns: z.object({",
        "    exitCode: z.number().nullable(),",
        "    stdout: z.string(),",
        "    stderr: z.string(),",
        "  }),",
        "  async run({ scratch }, { name }) {",
        "    return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("reads --no-command as no --command", async () => {
    const result = await cli(rootDir, ["scaffold", "plain", "--no-command"]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "plain"), "utf8")).toContain('throw new Error("not implemented: plain");');
  });

  it("escapes a quote and a backslash in the entry point", async () => {
    await mkdir(path.join(rootDir, "bin"));
    await writeFile(path.join(rootDir, "bin", 'say "hi"\\x.mjs'), "");
    const result = await cli(rootDir, ["scaffold", "run-odd", "--command", 'bin/say "hi"\\x.mjs']);

    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "run-odd"), "utf8")).toContain(
      'const cli = resolve("bin/say \\"hi\\"\\\\x.mjs");\n',
    );
  });

  it.each([
    ["a missing file", "src/clli.ts"],
    ["a directory", "features"],
    ["a missing file given as an absolute path", "/nonexistent/cli.ts"],
  ])("refuses %s as the entry point and writes nothing", async (_label, entry) => {
    const result = await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command", entry]);

    expect(result.stderr).toBe(
      `Refusing to scaffold: entry point "${entry}" is not a file (looked at ${path.resolve(rootDir, entry)}); pass the path of the program the step runs, relative to the directory nuka runs in, or give --command no value to leave a TODO\ndo: nuka scaffold --help\n`,
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "run-greet"))).toBe(false);
  });

  it("writes an entry point given as an absolute path when the file exists", async () => {
    const entry = path.join(rootDir, "nukadoko.config.ts");
    const result = await cli(rootDir, ["scaffold", "run-pkg", "--command", entry]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "run-pkg"), "utf8")).toContain(`const cli = resolve(${JSON.stringify(entry)});\n`);
  });

  it("names the option order when a step name went to --command and a name follows", async () => {
    const result = await cli(rootDir, ["scaffold", "--command", "run-y", "--pattern", "I run y", "other"]);

    expect(result.stderr).toBe(
      `Refusing to scaffold: entry point "run-y" is not a file (looked at ${path.join(rootDir, "run-y")}); pass the path of the program the step runs, relative to the directory nuka runs in, or give --command no value to leave a TODO; --command before the name takes the next word as its value ("run-y" here); write the name first, or give --command a value\ndo: nuka scaffold --help\n`,
    );
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "other"))).toBe(false);
  });

  it("names the option order when a step name went to --command and no name is left", async () => {
    const result = await cli(rootDir, ["scaffold", "--command", "run-y", "--pattern", "I run y"]);

    expect(result.stderr).toBe(
      [
        "Missing required argument: name (or --feature <path>)",
        '--command before the name takes the next word as its value ("run-y" here); write the name first, or give --command a value',
        "do: nuka scaffold --help",
        "",
      ].join("\n"),
    );
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "run-y"))).toBe(false);
  });

  it("passes check with the TODO left in, and fails do and run by name at the When step", async () => {
    await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command"]);
    await cli(rootDir, ["scaffold", "output-says", "--pattern", "the output says {text:string}", "--then", "--from", "run-greet.stdout"]);
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      ["Feature: greet", "  Scenario: greet a name", '    When I run greet with "Ada"', '    Then the output says "Hello, Ada!"', ""].join(
        "\n",
      ),
    );

    const check = await cli(rootDir, ["check"]);
    expect(check.stdout + check.stderr).toBe("ok: no issues found\n");

    const message = "fill in the entry point: features/steps/run-greet.ts:4";
    const done = await cli(rootDir, ["do", "run-greet", "--args", '{"name":"Ada"}']);
    expect(done.exitCode).not.toBe(0);
    expect(done.stdout + done.stderr).toContain(message);

    const run = await cli(rootDir, ["run", "features/greet.feature"]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(message);
    // The Then step is never reached with an empty stdout.
    expect(run.stdout).not.toContain("not implemented: output-says");
  });

  it("chains --from at once, and runs a real program green once the entry point is filled in and the output trimmed", async () => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(
      path.join(rootDir, "src", "greet.mjs"),
      'process.stdout.write(`Hello, ${process.argv[2]}!\\n`);\nprocess.stderr.write("cwd " + process.cwd() + "\\n");\n',
    );
    await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command"]);
    const then = await cli(rootDir, [
      "scaffold",
      "output-says",
      "--pattern",
      "the output says {text:string}",
      "--then",
      "--from",
      "run-greet.stdout",
    ]);
    expect(then.stderr).toBe("");
    expect(then.exitCode).toBe(0);
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      ["Feature: greet", "  Scenario: greet a name", '    When I run greet with "Ada"', '    Then the output says "Hello, Ada!"', ""].join(
        "\n",
      ),
    );

    const unimplemented = await cli(rootDir, ["run", "features/greet.feature"]);
    expect(unimplemented.exitCode).toBe(1);

    const runGreet = stepPath(rootDir, "run-greet");
    // Absolute, because `resolve` reads a relative path from the directory
    // nuka runs in, and this test runs nuka in-process from elsewhere.
    await writeFile(
      runGreet,
      (await readFile(runGreet, "utf8")).replace("<TODO: the entry point>", path.join(rootDir, "src", "greet.mjs")),
    );
    const outputSays = stepPath(rootDir, "output-says");
    const unedited = "const actual = stdout;";
    expect(await readFile(outputSays, "utf8")).toContain(unedited);
    await writeFile(outputSays, (await readFile(outputSays, "utf8")).replace(unedited, "const actual = stdout.trim();"));

    // The scaffolded assertion, unedited, names the expected and the actual value.
    const asserted = await cli(rootDir, ["scaffold", "exit-is", "--pattern", "it exits {code:int}", "--then", "--from", "run-greet.exitCode"]);
    expect(asserted.exitCode).toBe(0);
    await writeFile(
      path.join(rootDir, "features", "exit.feature"),
      ["Feature: exit", "  Scenario: exits three", '    When I run greet with "Ada"', "    Then it exits 3", ""].join("\n"),
    );
    const exitRun = await cli(rootDir, ["run", "features/exit.feature"]);
    expect(exitRun.exitCode).toBe(1);
    expect(exitRun.stderr).toContain("\n      code: expected 3, got 0\n");

    const green = await cli(rootDir, ["run", "features/greet.feature"]);
    expect(green.stderr).toContain("1 scenario: 1 passed, 0 failed");
    expect(green.exitCode).toBe(0);
  });

  it("names the producer that exited nonzero, and its first stderr line, when the Then step fails", async () => {
    await mkdir(path.join(rootDir, "src"));
    // What a NodeNext entry point does under `node` when it imports a
    // `.js` specifier for a `.ts` file: nothing on stdout, exit 1.
    await writeFile(
      path.join(rootDir, "src", "greet.mjs"),
      'process.stderr.write("\\nError [ERR_MODULE_NOT_FOUND]: Cannot find module greet.js, token tok-0123456789\\n    at x\\n");\nprocess.exit(1);\n',
    );
    // Outside a committed tracked file, every env file value is a secret.
    await writeFile(path.join(rootDir, ".env.local"), "TOKEN=tok-0123456789\n");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({ envFiles: [".env.local"] });\n',
    );
    const entry = path.join(rootDir, "src", "greet.mjs");
    await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command", entry]);
    await cli(rootDir, ["scaffold", "output-says", "--pattern", "the output says {text:string}", "--then", "--from", "run-greet.stdout"]);
    const outputSays = stepPath(rootDir, "output-says");
    await writeFile(
      outputSays,
      (await readFile(outputSays, "utf8")).replace("const actual = stdout;", "const actual = stdout.trim();"),
    );
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      ["Feature: greet", "  Scenario: greet a name", '    When I run greet with "Ada"', '    Then the output says "Hello, Ada!"', ""].join(
        "\n",
      ),
    );

    const run = await cli(rootDir, ["run", "features/greet.feature"]);
    expect(run.exitCode).toBe(1);
    const failed = run.stderr.slice(run.stderr.indexOf("step 2/2"));
    expect(failed).toMatch(
      new RegExp(
        [
          "step 2/2  failed  \\d+\\.\\ds  the output says \"Hello, Ada!\"",
          '      text: expected "Hello, Ada!", got ""',
          "      used    run-greet  exit 1  Error \\[ERR_MODULE_NOT_FOUND\\]: Cannot find module greet\\.js, token \\{\\{secret\\.TOKEN\\}\\}",
          "      record  \\.nukadoko/records/steps/step-",
        ].join("\n"),
      ),
    );
    expect(run.stderr).not.toContain("tok-0123456789");

    const runsDir = path.join(rootDir, ".nukadoko", "records", "runs");
    const [runId] = await readdir(runsDir);
    const summary = await readFile(path.join(runsDir, runId!, "summary.md"), "utf8");
    expect(summary).toContain(
      'step "the output says "Hello, Ada!"": `text: expected "Hello, Ada!", got ""`<br>' +
        "used run-greet exit 1: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module greet.js, token {{secret.TOKEN}}`<br>record ",
    );
  });

  it("runs a real program green with the entry point named on the command line, with no edit to the When step", async () => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "greet.mjs"), 'process.stdout.write(`Hello, ${process.argv[2]}!\\n`);\n');
    // Absolute, because `resolve` reads a relative path from the directory
    // nuka runs in, and this test runs nuka in-process from elsewhere.
    const entry = path.join(rootDir, "src", "greet.mjs");
    await cli(rootDir, ["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command", entry]);

    const done = await cli(rootDir, ["do", "run-greet", "--args", '{"name":"Ada"}']);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('Hello, Ada!');
  });
});

const WRITE_FILE = [
  'import { defineStep, z } from "nukadoko";',
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "",
  "export default defineStep({",
  '  description: "writes a file in a fresh scratch directory",',
  '  pattern: "a file {name:string} holding {text:string}",',
  "  args: z.object({ name: z.string(), text: z.string() }),",
  '  returns: z.object({ dir: z.string().describe("where the file is") }),',
  "  run({ scratch }, { name, text }) {",
  "    const dir = scratch.dir();",
  "    writeFileSync(join(dir, name), text);",
  "    return { dir };",
  "  },",
  "});",
  "",
].join("\n");

const EMPTY_DIR = [
  'import { defineStep, z } from "nukadoko";',
  "",
  "export default defineStep({",
  '  description: "a fresh, empty scratch directory",',
  '  pattern: "an empty directory",',
  "  args: z.object({}),",
  '  returns: z.object({ dir: z.string().describe("the directory") }),',
  "  run({ scratch }) {",
  "    return { dir: scratch.dir() };",
  "  },",
  "});",
  "",
].join("\n");

describe("nuka scaffold --command --cwd", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
    await writeFile(stepPath(rootDir, "write-file"), WRITE_FILE);
    await writeFile(stepPath(rootDir, "empty-dir"), EMPTY_DIR);
    await mkdir(path.join(rootDir, "src"));
    await writeFile(
      path.join(rootDir, "src", "show.mjs"),
      'import { readFileSync } from "node:fs";\ntry { process.stdout.write(readFileSync(process.argv[2], "utf8")); } catch { process.exit(2); }\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs the program in the directory either producer returned, with no hand edit to any scaffolded step", async () => {
    // Absolute, because `resolve` reads a relative path from the directory
    // nuka runs in, and this test runs nuka in-process from elsewhere.
    const entry = path.join(rootDir, "src", "show.mjs");
    const scaffolds = [
      ["scaffold", "run-show", "--pattern", "I show {file:string}", "--command", entry, "--from", "write-file.dir", "--from", "empty-dir.dir", "--cwd", "dir"],
      ["scaffold", "output-is", "--pattern", "the output is {text:string}", "--then", "--from", "run-show.stdout"],
      ["scaffold", "exits-with", "--pattern", "it exits with {code:int}", "--then", "--from", "run-show.exitCode"],
    ];
    for (const argv of scaffolds) {
      const result = await cli(rootDir, argv);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    expect(await readFile(stepPath(rootDir, "run-show"), "utf8")).toBe(
      [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        'import writeFile from "./write-file.ts";',
        'import emptyDir from "./empty-dir.ts";',
        "",
        `const cli = resolve(${JSON.stringify(entry)});`,
        "",
        "export default defineStep({",
        '  description: "Run the command under test in the directory dir names",',
        '  pattern: "I show {file:string}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    file: z.string(),",
        "    dir: writeFile.returns.shape.dir,",
        "  }),",
        "  from: {",
        '    dir: [[writeFile, "dir"], [emptyDir, "dir"]],',
        "  },",
        "  returns: z.object({",
        "    exitCode: z.number().nullable(),",
        "    stdout: z.string(),",
        "    stderr: z.string(),",
        "  }),",
        "  async run({}, { file, dir }) {",
        "    return await runCommand(process.execPath, [cli, file], { cwd: dir });",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, "features", "show.feature"),
      [
        "Feature: show",
        "  Scenario: a file a Given wrote",
        '    Given a file "a.txt" holding "hi"',
        '    When I show "a.txt"',
        '    Then the output is "hi"',
        "  Scenario: an empty directory",
        "    Given an empty directory",
        '    When I show "a.txt"',
        "    Then it exits with 2",
        "",
      ].join("\n"),
    );

    const check = await cli(rootDir, ["check"]);
    expect(check.stdout + check.stderr).toBe("ok: no issues found\n");
    const run = await cli(rootDir, ["run", "features/show.feature"]);
    expect(run.stderr).toContain("2 scenarios: 2 passed, 0 failed");
    expect(run.exitCode).toBe(0);
  });

  it("keeps a chained value out of argv, and fails the run by name until the value is placed", async () => {
    const entry = path.join(rootDir, "src", "show.mjs");
    const result = await cli(rootDir, ["scaffold", "run-show", "--pattern", "I show {file:string}", "--command", entry, "--from", "write-file.dir"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const text = await readFile(stepPath(rootDir, "run-show"), "utf8");
    expect(text).toContain(
      [
        "  async run({ scratch }, { file, dir }) {",
        "    // TODO: pass each chained value where the program reads it: an environment",
        "    // variable (runCommand's env, with ...process.env), a flag, or --cwd. Then delete the throw.",
        "    throw new Error(`pass dir where the program reads them: features/steps/run-show.ts:26; args ${JSON.stringify({ dir })}`);",
        "    return await runCommand(process.execPath, [cli, file], { cwd: scratch.dir() });",
      ].join("\n"),
    );
    expect(text.split("\n")[25]).toContain("throw new Error(`pass dir where");
    await writeFile(
      path.join(rootDir, "features", "show.feature"),
      ["Feature: show", "  Scenario: a file a Given wrote", '    Given a file "a.txt" holding "hi"', '    When I show "a.txt"', ""].join("\n"),
    );

    const check = await cli(rootDir, ["check"]);
    expect(check.stdout + check.stderr).toContain("warning\tscenario-without-then");
    const run = await cli(rootDir, ["run", "features/show.feature"]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("pass dir where the program reads them: features/steps/run-show.ts:26; args {");
  });

  it.each([
    [["--pattern", "show {file:string}", "--cwd", "file"], "--cwd names the directory the program runs in, and only a --command step runs one"],
    [["--command", "--pattern", "show {file:string}", "--cwd", "dir"], "--cwd dir names no args key of this step (its keys are file); pass the key a --from or a capture fills"],
    [["--command", "--cwd", "dir"], "--cwd dir names no args key of this step (it has none); pass the key a --from or a capture fills"],
    [
      ["--command", "--pattern", "show in {n:int}", "--cwd", "n"],
      "--cwd n may hold a value that is not a string, and runCommand takes cwd as a string; chain a key whose schema is a bare z.string(), or capture it as {n:string}",
    ],
    [["--command", "--cwd", "a", "--cwd", "b"], "--cwd was given more than once."],
  ])("refuses %j and writes nothing", async (flags, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", ...flags]);

    expect(result.stderr).toContain(message);
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "broken"))).toBe(false);
  });
});

// Property: scaffold writes a file for an entry point exactly when a
// regular file exists at that path under the directory it runs in, and the
// `resolve(...)` literal it writes evaluates back to that same string, so a
// quote, a backslash, or any other character cannot break the file or
// change the path.
describe("nuka scaffold --command <entry point>: any path", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a file iff the entry point is a regular file, and round trips through the written resolve() literal", () =>
    hegel.testAsync(
      async (tc) => {
        const entry = tc.draw(
          gs.oneOf(
            gs.text({ minSize: 1, maxSize: 30 }),
            // Line terminators, which a regex `.` and a source line both treat specially.
            gs.text({ minSize: 1, maxSize: 4, alphabet: "a\u2028\u2029\r" }),
            // The characters a string literal escapes or a template literal reads.
            gs.text({ minSize: 1, maxSize: 12, alphabet: "a/\\\"'`${}.\n" }),
          ),
        );
        const exists = tc.draw(gs.booleans());
        // yargs reads a leading "-" as a flag; such a value never reaches scaffold.
        tc.assume(!entry.startsWith("-"));
        const target = path.resolve(rootDir, entry);
        // Inside the project, and not a path the project already holds.
        tc.assume(target.startsWith(`${rootDir}${path.sep}`) && !existsSync(target));
        if (exists) {
          const made = await mkdir(path.dirname(target), { recursive: true })
            .then(() => writeFile(target, ""))
            .then(
              () => true,
              () => false,
            );
          tc.assume(made);
        }
        counter += 1;
        const name = `run-path-${counter}`;
        try {
          const result = await cli(rootDir, ["scaffold", name, "--command", entry]);
          if (!exists) {
            expect(result.stderr).toContain(`Refusing to scaffold: entry point ${JSON.stringify(entry)} is not a file`);
            expect(result.exitCode).toBe(2);
            expect(existsSync(stepPath(rootDir, name))).toBe(false);
            return;
          }
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
          const text = await readFile(stepPath(rootDir, name), "utf8");
          const line = text.split("\n")[3]!;
          // `s`: a JSON string may hold U+2028, which `.` alone does not match.
          const literal = /^const cli = resolve\((.*)\);$/s.exec(line)?.[1];
          expect(literal).toBeDefined();
          expect(runInNewContext(literal!)).toBe(entry);
          expect(text).not.toContain("fill in the entry point");
        } finally {
          await rm(stepPath(rootDir, name), { force: true });
          if (exists) await rm(target, { force: true });
        }
      },
      { testCases: 40, suppressHealthCheck: [hegel.HealthCheck.TooSlow, hegel.HealthCheck.FilterTooMuch] },
    ), 300_000);
});

// Property: for any pattern built from literal words and typed captures,
// the `--command` file imports and binds a feature line that fills it with
// no `nuka check` finding, and a Then step can be scaffolded `--from` each
// of its three returns keys immediately after, with no edit in between.
describe("nuka scaffold --command: any pattern", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  // Each capture type with a feature-line value it matches.
  const CAPTURES: readonly (readonly [string, string])[] = [
    ["int", "3"],
    ["float", "1.5"],
    ["word", "plain"],
    ["string", '"two words"'],
    ["", '"anon"'],
    ["biginteger", "12345678901234567890"],
    ["bigdecimal", "2.25"],
  ];

  it("binds a filled-in feature line with no finding, and chains every returns key at once", () =>
    hegel.testAsync(
      async (tc) => {
        const pieces = tc.draw(
          gs.arrays(gs.oneOf(gs.fromRegex("[a-z]{1,6}"), gs.sampledFrom(CAPTURES.map((_, index) => `#${index}`))), {
            minSize: 1,
            maxSize: 5,
          }),
        );
        const pattern: string[] = [];
        const line: string[] = [];
        pieces.forEach((piece, index) => {
          if (!piece.startsWith("#")) {
            pattern.push(piece);
            line.push(piece);
          } else {
            const [type, value] = CAPTURES[Number(piece.slice(1))]!;
            pattern.push(`{k${index}:${type}}`);
            line.push(value);
          }
        });
        counter += 1;
        // A literal word per case keeps each pattern distinct from every other case's.
        const name = `run-case-${counter}`;
        const patternText = [`case${counter}`, ...pattern].join(" ");
        const lineText = [`case${counter}`, ...line].join(" ");
        const featurePath = path.join(rootDir, "features", `${name}.feature`);
        const written = [name];
        try {
          const scaffold = await cli(rootDir, ["scaffold", name, "--pattern", patternText, "--command"]);
          expect(scaffold.stderr).toBe("");
          expect(scaffold.exitCode).toBe(0);
          await writeFile(featurePath, `Feature: f\n  Scenario: s\n    When ${lineText}\n`);
          const check = await cli(rootDir, ["check"]);
          // The feature is the one When line, so its only finding is the missing Then.
          expect(check.stdout + check.stderr).toBe(
            `warning\tscenario-without-then\tfeatures/${name}.feature:2\tScenario "s" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n  do: Add a Then line that checks the outcome the scenario is for.\n`,
          );
          for (const key of ["stdout", "exitCode", "stderr"]) {
            const consumer = `${name}-${key.toLowerCase()}`;
            written.push(consumer);
            const chained = await cli(rootDir, ["scaffold", consumer, "--then", "--from", `${name}.${key}`]);
            expect(chained.stderr).toBe("");
            expect(chained.exitCode).toBe(0);
          }
        } finally {
          await rm(featurePath, { force: true });
          for (const step of written) await rm(stepPath(rootDir, step), { force: true });
        }
      },
      // Each case runs scaffold four times and check once, and each of them
      // loads every step file, so a case is slow by design and a loaded
      // machine must not fail it on time alone.
      { testCases: 15, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

const execFileAsync = promisify(execFile);

/** Compiles step files against the built package, as a project that sets
 * `noUnusedLocals` and `noUnusedParameters` would. "nukadoko" is linked to
 * this repository, so it resolves through package.json's own `exports` to
 * the built declarations: the shim under tests/.tmp-fixtures points at
 * `src/`, whose own files these flags would also check. */
async function typecheckSteps(files: Record<string, string>): Promise<{ code: number; output: string }> {
  // Under tests/ so "nukadoko" resolves to this package by its own name.
  const parent = path.join(testsDir, ".tmp-fixtures");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "scaffold-command-types-"));
  try {
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
    await mkdir(path.join(dir, "node_modules"));
    await symlink(repoRoot, path.join(dir, "node_modules", "nukadoko"), "dir");
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ESNext"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          skipLibCheck: true,
          noEmit: true,
          // What `nuka init` adds, so the `.ts` import names scaffold writes check.
          rewriteRelativeImportExtensions: true,
          types: ["node"],
        },
        include: ["*.ts"],
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

describe("every scaffolded variant", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("type checks under noUnusedLocals and noUnusedParameters", async () => {
    // A producer whose value may be absent: the command passes it through String().
    const maybeName = [
      'import { defineStep, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "may name someone",',
      "  args: z.object({}),",
      "  returns: z.object({ name: z.string().optional() }),",
      "  run() {",
      "    return {};",
      "  },",
      "});",
      "",
    ].join("\n");
    await writeFile(stepPath(rootDir, "maybe-name"), maybeName);
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({ parameterTypes: [{ name: "colour", regexp: /red|blue/ }] });\n',
    );
    const variants: readonly (readonly string[])[] = [
      ["scaffold", "bare-when"],
      ["scaffold", "bare-then", "--then"],
      ["scaffold", "args-when", "--pattern", "set {n:int} {w:word} {b:biginteger} {c:colour}"],
      ["scaffold", "args-then", "--pattern", "the total is {total:float}", "--then"],
      ["scaffold", "run-bare", "--command"],
      ["scaffold", "run-args", "--pattern", "run with {s:string} {n:int} {b:biginteger}", "--command"],
      ["scaffold", "chained-then", "--pattern", "it printed {text:string}", "--then", "--from", "run-args.stdout", "--from", "run-args.exitCode"],
      ["scaffold", "asserted-then", "--pattern", "it said {text:string}", "--then", "--from", "run-args.stdout"],
      ["scaffold", "exit-then", "--pattern", "it exited {code:int}", "--then", "--from", "run-args.exitCode"],
      ["scaffold", "big-then", "--pattern", "the count is {n:biginteger}", "--then"],
      ["scaffold", "colour-then", "--pattern", "the colour is {c:colour}", "--then"],
      ["scaffold", "chained-command", "--command", "--from", "run-args.stdout", "--from", "run-args.exitCode"],
      ["scaffold", "chained-optional", "--command", "--from", "maybe-name.name"],
      ["scaffold", "run-named", "--pattern", "run named {s:string}", "--command", "src/cli.ts"],
      ["scaffold", "run-in-capture", "--pattern", "run {s:string} in {where:string}", "--command", "src/cli.ts", "--cwd", "where"],
      ["scaffold", "run-in-chained", "--command", "--from", "run-args.stdout", "--from", "run-named.stdout", "--cwd", "stdout"],
    ];
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "cli.ts"), "");
    const files: Record<string, string> = { "maybe-name.ts": maybeName };
    for (const argv of variants) {
      const result = await cli(rootDir, [...argv]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      files[`${argv[1]}.ts`] = await readFile(stepPath(rootDir, argv[1]!), "utf8");
    }
    expect(files["chained-command.ts"]).toContain(
      [
        "    // TODO: pass each chained value where the program reads it: an environment",
        "    // variable (runCommand's env, with ...process.env), a flag, or --cwd. Then delete the throw.",
        "    throw new Error(`pass stdout, exitCode where the program reads them: features/steps/chained-command.ts:28; args ${JSON.stringify({ stdout, exitCode }, (_key, value) => (typeof value === \"bigint\" ? String(value) : value))}`);",
        "    return await runCommand(process.execPath, [cli], { cwd: scratch.dir() });",
      ].join("\n"),
    );
    expect(files["chained-command.ts"]!.split("\n")[27]).toContain("throw new Error(`pass stdout, exitCode");
    expect(files["chained-optional.ts"]).toContain(
      "args ${JSON.stringify({ name }, (_key, value) => (typeof value === \"bigint\" ? String(value) : value))}`);\n    return await runCommand(process.execPath, [cli], { cwd: scratch.dir() });",
    );
    expect(files["run-in-capture.ts"]).toContain("[cli, s], { cwd: where });");
    expect(files["run-in-chained.ts"]).toContain("[cli], { cwd: stdout });");
    expect(files["chained-then.ts"]).toContain("throw new Error(`not implemented: chained-then;");
    expect(files["big-then.ts"]).toContain("    assert.equal(actual, n, `n: expected ${n}, got ${actual}`);\n");
    expect(files["colour-then.ts"]).toContain(
      '    assert.deepEqual(actual, c, `c: expected ${JSON.stringify(c, (_key, value) => (typeof value === "bigint" ? String(value) : value))}, got ${JSON.stringify(actual, (_key, value) => (typeof value === "bigint" ? String(value) : value))}`);\n',
    );
    // The guard names the line that holds the TODO, imports or not.
    for (const file of ["run-bare.ts", "run-args.ts", "chained-command.ts", "chained-optional.ts", "run-in-chained.ts"]) {
      const text = files[file]!;
      const named = new RegExp(`fill in the entry point: features/steps/${file.replace(".", "\\.")}:(\\d+)`).exec(text);
      expect(named).not.toBeNull();
      expect(text.split("\n")[Number(named![1]) - 1]).toBe('const cli = resolve("<TODO: the entry point>");');
    }

    const typecheck = await typecheckSteps(files);
    expect(typecheck.output).toBe("");
    expect(typecheck.code).toBe(0);
  });
});

// A TypeScript entry point that imports a sibling as `./greet.js` cannot
// start under plain `node`, which does not rewrite the specifier to the
// `./greet.ts` that exists. The scaffold refuses that entry point instead of
// writing a step whose run is red before the program starts.
describe("nuka scaffold --command <entry point>: the entry point's own imports", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  async function scaffoldWith(files: Record<string, string>, entry: string): Promise<{ result: Awaited<ReturnType<typeof cli>>; written: boolean }> {
    await rm(path.join(rootDir, "src"), { recursive: true, force: true });
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(rootDir, file)), { recursive: true });
      await writeFile(path.join(rootDir, file), text);
    }
    counter += 1;
    const name = `run-imports-${counter}`;
    const result = await cli(rootDir, ["scaffold", name, "--command", entry]);
    const written = existsSync(stepPath(rootDir, name));
    await rm(stepPath(rootDir, name), { force: true });
    return { result, written };
  }

  const greet = "export const greet = (name: string): string => `hello ${name}`;\n";

  it("refuses an entry point that imports ./greet.js beside greet.ts, and writes nothing", async () => {
    const { result, written } = await scaffoldWith(
      { "src/cli.ts": 'import { greet } from "./greet.js";\nconsole.log(greet("a"));\n', "src/greet.ts": greet },
      "src/cli.ts",
    );

    expect(result.stderr).toBe(
      'Refusing to scaffold: entry point "src/cli.ts" imports "./greet.js", which does not exist (src/greet.ts does); node runs a .ts file without rewriting that specifier, so the step would exit 1 with ERR_MODULE_NOT_FOUND. Point --command at the built program (for example dist/cli.js, after npm run build), or import "./greet.ts" with "rewriteRelativeImportExtensions": true in tsconfig.json\ndo: nuka scaffold --help\n',
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
    expect(written).toBe(false);
  });

  it("accepts the same entry point when greet.js exists on disk", async () => {
    const { result, written } = await scaffoldWith(
      {
        "src/cli.ts": 'import { greet } from "./greet.js";\nconsole.log(greet("a"));\n',
        "src/greet.ts": greet,
        "src/greet.js": "export const greet = (name) => `hello ${name}`;\n",
      },
      "src/cli.ts",
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(written).toBe(true);
  });

  it.each([
    ["no relative import", { "src/cli.ts": 'import { argv } from "node:process";\nconsole.log(argv);\n' }],
    ["a .ts specifier", { "src/cli.ts": 'import { greet } from "./greet.ts";\nconsole.log(greet("a"));\n', "src/greet.ts": greet }],
    ["a .js specifier with no .ts sibling either", { "src/cli.ts": 'import "./missing.js";\n' }],
    ["a type-only import, which type stripping erases", { "src/cli.ts": 'import type { T } from "./greet.js";\nconst x: T = "a";\n', "src/greet.ts": "export type T = string;\n" }],
    ["an import in a comment", { "src/cli.ts": '// import { greet } from "./greet.js";\n/* export * from "./greet.js"; */\n', "src/greet.ts": greet }],
  ])("accepts an entry point with %s", async (_label, files) => {
    const { result, written } = await scaffoldWith(files, "src/cli.ts");

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(written).toBe(true);
  });

  it("never reads a .js entry point for this", async () => {
    const { result, written } = await scaffoldWith(
      { "src/cli.js": 'import { greet } from "./greet.js";\n', "src/greet.ts": greet },
      "src/cli.js",
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(written).toBe(true);
  });

  it("resolves ../ against the entry point's directory, and maps .mjs to .mts", async () => {
    const { result, written } = await scaffoldWith(
      { "src/bin/cli.mts": 'export { run } from "../lib/run.mjs";\n', "src/lib/run.mts": "export const run = (): void => {};\n" },
      "src/bin/cli.mts",
    );

    expect(result.stderr).toBe(
      'Refusing to scaffold: entry point "src/bin/cli.mts" imports "../lib/run.mjs", which does not exist (src/lib/run.mts does); node runs a .ts file without rewriting that specifier, so the step would exit 1 with ERR_MODULE_NOT_FOUND. Point --command at the built program (for example dist/cli.js, after npm run build), or import "../lib/run.mts" with "rewriteRelativeImportExtensions": true in tsconfig.json\ndo: nuka scaffold --help\n',
    );
    expect(result.exitCode).toBe(2);
    expect(written).toBe(false);
  });

  // Property: for any entry file whose import lines name random relative
  // targets, with a random subset of each target's `.js` and TypeScript files
  // on disk, the scaffold refuses iff some value import's `.js` target is
  // absent while its TypeScript sibling is present.
  it("refuses iff some imported .js target is absent and its TypeScript sibling present", () =>
    hegel.testAsync(
      async (tc) => {
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const imports = Array.from({ length: count }, (_, index) => ({
          dir: tc.draw(gs.sampledFrom(["./", "../", "./lib/", "../lib/"])),
          base: tc.draw(gs.sampledFrom(["a", "b", "c"])),
          ext: tc.draw(gs.sampledFrom(["js", "mjs", "cjs", "ts"])),
          form: tc.draw(gs.sampledFrom(["named", "side-effect", "re-export", "type-only", "multi-line"])),
          index,
        }));
        const files: Record<string, string> = {};
        const states = new Map<string, string>();
        for (const entry of imports) {
          const target = path.posix.join("src/bin", `${entry.dir}${entry.base}.${entry.ext}`);
          if (states.has(target)) continue;
          const state = tc.draw(gs.sampledFrom(["none", "js", "ts", "both"]));
          states.set(target, state);
          const tsTwin = target.replace(/js$/, "ts");
          if (state === "js" || state === "both") files[target] = "export const v = 1;\n";
          if ((state === "ts" || state === "both") && tsTwin !== target) files[tsTwin] = "export const v = 1;\n";
        }
        const lines = imports.map(({ dir, base, ext, form, index }) => {
          const specifier = JSON.stringify(`${dir}${base}.${ext}`);
          if (form === "named") return `import { v as v${index} } from ${specifier};`;
          if (form === "side-effect") return `import ${specifier};`;
          if (form === "re-export") return `export * from ${specifier};`;
          if (form === "multi-line") return `import {\n  v as m${index},\n} from ${specifier};`;
          return `import type { V } from ${specifier};`;
        });
        files["src/bin/cli.ts"] = `${lines.join("\n")}\n`;
        const refuses = imports.some(({ dir, base, ext, form }) => {
          if (form === "type-only" || ext === "ts") return false;
          const target = path.posix.join("src/bin", `${dir}${base}.${ext}`);
          return !(target in files) && target.replace(/js$/, "ts") in files;
        });

        const { result, written } = await scaffoldWith(files, "src/bin/cli.ts");

        expect(result.exitCode).toBe(refuses ? 2 : 0);
        expect(written).toBe(!refuses);
        if (refuses) expect(result.stderr).toMatch(/^Refusing to scaffold: entry point "src\/bin\/cli\.ts" imports "/);
        else expect(result.stderr).toBe("");
      },
      { testCases: 30, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

describe("relativeJsImports", () => {
  it("names each static value import and re-export, in source order, and skips type-only, dynamic, commented, and quoted ones", () => {
    const source = [
      'import a from "./a.js";',
      "import {",
      "  b,",
      '} from "../b.mjs";',
      "import './c.cjs';",
      'export { d } from "./d.js";',
      'export * as e from "./e.js";',
      'import { type F } from "./f.js";',
      'import type { G } from "./g.js";',
      'export type { H } from "./h.js";',
      'const i = await import("./i.js");',
      'import j from "pkg/j.js";',
      'import k from "./k.ts";',
      '// import l from "./l.js";',
      'import type from "./m.js";',
      'const n = \'import "./n.js"\';',
    ].join("\n");

    expect(relativeJsImports(source)).toEqual(["./a.js", "../b.mjs", "./c.cjs", "./d.js", "./e.js", "./f.js", "./m.js"]);
  });
});
