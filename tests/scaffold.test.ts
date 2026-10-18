import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  fixture,
  removeTempDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name>` — the generated template's shape
// and its "fails until
// implemented" contract, name validation, the existing-file refusal, and
// the config-load-failure path scaffold shares with every other command
// that needs config. Every test here runs `nuka init` first in
// `beforeEach`, so the very first test below — scaffold immediately after
// init, then `nuka steps` seeing the new name — *is* the
// required "init directly followed by scaffold, then steps" integration
// walkthrough, not a separate fixture.

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

describe("nuka scaffold", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    const initExit = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    if (initExit !== 0) {
      throw new Error("test setup: `nuka init` failed");
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs init -> scaffold -> steps end to end: the new name appears in the vocabulary", async () => {
    const scaffoldStdout = createCaptureSink();
    const scaffoldExit = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: scaffoldStdout,
      stderr: createCaptureSink(),
    });

    expect(scaffoldExit).toBe(0);
    expect(scaffoldStdout.text().trim()).toBe(path.join("features", "steps", "send-invite.ts"));

    // `z` comes from nukadoko's own re-export, not a direct `zod`
    // dependency: a step file that imported `zod` itself would fail to
    // resolve it under a package manager that does not hoist a
    // dependency's own dependencies to the project's top level.
    const content = await readFile(path.join(rootDir, "features", "steps", "send-invite.ts"), "utf8");
    expect(content).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "TODO: describe send-invite",',
        '  // pattern: "the feature line this step matches", (without one, the step is called by name only)',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({}),",
        "  // Return what later steps cite and the values this step's correctness rests on;",
        '  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
        "  // returns: z.object({ ... }),",
        "  run() {",
        '    throw new Error("not implemented: send-invite");',
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const stepsStdout = createCaptureSink();
    const stepsExit = await runCli(["steps", "--json"], {
      rootDir,
      stdout: stepsStdout,
      stderr: createCaptureSink(),
    });
    expect(stepsExit).toBe(0);
    const { steps: summaries } = JSON.parse(stepsStdout.text());
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "send-invite",
          patterns: [],
          mutates: true,
          description: "TODO: describe send-invite",
        }),
      ]),
    );
  });

  it("fails until implemented: `nuka do` exits 1 with a failed step record", async () => {
    await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "send-invite", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.message).toBe("not implemented: send-invite");
  });

  it("rejects a name outside [a-z0-9-]+, writing nothing", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "Bad_Name"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).not.toBe("");
    expect(existsSync(path.join(rootDir, "features", "steps", "Bad_Name.ts"))).toBe(false);
  });

  it("refuses to overwrite an existing step file", async () => {
    await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    const filePath = path.join(rootDir, "features", "steps", "send-invite.ts");
    const original = (await readFile(filePath, "utf8")).replace('"TODO: describe send-invite"', '"Send an invite"');
    await writeFile(filePath, original);

    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite", "--pattern", "I invite {email:string} to Bob's team"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe(
      "Refusing to scaffold: features/steps/send-invite.ts already exists\n" +
        "do: rm features/steps/send-invite.ts if it holds no step to keep (or choose another step name), " +
        "then run nuka scaffold send-invite --pattern 'I invite {email:string} to Bob'\\''s team'\n",
    );
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("exits 2 when the project's config fails to load", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir: fixture("invalid-config-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("typo");
  });
});

// Responsibility: a CommonJS project (no "type": "module" in package.json)
// gets `nuka init` writing nukadoko.config.mts and telling the user to
// write step files as .mts too (tests/init.test.ts's own "nuka init:
// CommonJS projects"). `nuka scaffold` has to honor that same fact for the
// file it writes itself: a scaffolded .ts step in such a project fails to
// import (`step-file-import-failed`) before its own `run()` ever runs, so
// the tool would be contradicting the guidance it just gave.
describe("nuka scaffold: CommonJS projects", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "cjs-project", private: true }),
    );
    const initExit = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    if (initExit !== 0) {
      throw new Error("test setup: `nuka init` failed");
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes <name>.mts, not <name>.ts, and `nuka check` passes with no rename needed", async () => {
    const scaffoldStdout = createCaptureSink();
    const scaffoldExit = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: scaffoldStdout,
      stderr: createCaptureSink(),
    });

    expect(scaffoldExit).toBe(0);
    expect(scaffoldStdout.text().trim()).toBe(path.join("features", "steps", "send-invite.mts"));
    expect(existsSync(path.join(rootDir, "features", "steps", "send-invite.mts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "features", "steps", "send-invite.ts"))).toBe(false);

    const checkStdout = createCaptureSink();
    const checkStderr = createCaptureSink();
    const checkExit = await runCli(["check"], {
      rootDir,
      stdout: checkStdout,
      stderr: checkStderr,
    });
    expect(checkExit).toBe(0);
    expect(checkStdout.text() + checkStderr.text()).not.toContain("step-file-import-failed");
  });

  it("refuses to overwrite an existing <name>.mts", async () => {
    await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    const filePath = path.join(rootDir, "features", "steps", "send-invite.mts");
    const original = await readFile(filePath, "utf8");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("send-invite.mts");
    expect(await readFile(filePath, "utf8")).toBe(original);
  });
});

// Regression: an explicit `"type": "module"` project (not merely a project
// with no package.json at all, which reads the same "not CommonJS" branch
// by a different route) still gets `.ts`, unchanged by the CommonJS branch
// above.
describe("nuka scaffold: an explicit ESM project (regression)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "esm-project", private: true, type: "module" }),
    );
    const initExit = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    if (initExit !== 0) {
      throw new Error("test setup: `nuka init` failed");
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("still writes <name>.ts, not <name>.mts", async () => {
    const scaffoldStdout = createCaptureSink();
    const scaffoldExit = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: scaffoldStdout,
      stderr: createCaptureSink(),
    });

    expect(scaffoldExit).toBe(0);
    expect(scaffoldStdout.text().trim()).toBe(path.join("features", "steps", "send-invite.ts"));
    expect(existsSync(path.join(rootDir, "features", "steps", "send-invite.ts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "features", "steps", "send-invite.mts"))).toBe(false);
  });
});

// Responsibility: `nuka scaffold <name> --description <text>`. The text
// replaces the TODO description (and `--command`'s own sentence) as a
// JSON string literal, so whatever it holds reads back unchanged.
describe("nuka scaffold --description", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await initProject();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes the text in place of the TODO", async () => {
    const result = await cli(rootDir, ["scaffold", "send-invite", "--description", "Send an invitation email"]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const text = await readFile(stepPath(rootDir, "send-invite"), "utf8");
    expect(text).toContain('  description: "Send an invitation email",\n');
    expect(text).not.toContain("TODO: describe");
  });

  it("escapes a quote and a backslash in the text", async () => {
    const result = await cli(rootDir, ["scaffold", "say", "--description", 'Says "hi" \\ there']);

    expect(result.exitCode).toBe(0);
    expect(await readFile(stepPath(rootDir, "say"), "utf8")).toContain('  description: "Says \\"hi\\" \\\\ there",\n');
  });

  it("replaces --command's own sentence", async () => {
    const result = await cli(rootDir, ["scaffold", "run-greet", "--command", "--description", "Run greet in a scratch directory"]);

    expect(result.exitCode).toBe(0);
    const text = await readFile(stepPath(rootDir, "run-greet"), "utf8");
    expect(text).toContain('  description: "Run greet in a scratch directory",\n');
    expect(text).not.toContain("Run the command under test");
  });

  it.each([
    [["--description", "a", "--description", "b"], "--description was given more than once.\n"],
    [
      ["--description", ""],
      "Refusing to scaffold: --description is empty; say what the step does, or leave the flag out for a TODO that nuka tend reports\n",
    ],
  ])("refuses %j and writes nothing", async (flags, message) => {
    const result = await cli(rootDir, ["scaffold", "broken", ...flags]);

    expect(result.stderr).toBe(`${message}do: nuka scaffold --help\n`);
    expect(result.exitCode).toBe(2);
    expect(existsSync(stepPath(rootDir, "broken"))).toBe(false);
  });
});

// Property: for any description without a line break, the written file
// imports and `nuka describe` reads the same text back.
describe("nuka scaffold --description: any text", () => {
  let rootDir: string;
  let counter = 0;

  beforeAll(async () => {
    rootDir = await initProject();
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("round trips through nuka describe", () =>
    hegel.testAsync(
      async (tc) => {
        const description = tc.draw(
          gs.oneOf(
            gs.text({ minSize: 1, maxSize: 30 }),
            // The characters a string literal escapes or a template literal reads, and a leading dash.
            gs.text({ minSize: 1, maxSize: 12, alphabet: "a \\\"'`${}\u2028\u2029-" }),
          ),
        );
        tc.assume(!/[\n\r]/.test(description));
        counter += 1;
        const name = `described-${counter}`;
        try {
          const result = await cli(rootDir, ["scaffold", name, "--description", description]);
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
          const described = await cli(rootDir, ["describe", name]);
          expect(described.exitCode).toBe(0);
          expect(JSON.parse(described.stdout).description).toBe(description);
        } finally {
          await rm(stepPath(rootDir, name), { force: true });
        }
      },
      { testCases: 30, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});
