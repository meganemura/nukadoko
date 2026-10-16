import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        '  // beside an absence (false, 0, ""), return proof the read was valid.',
        "  returns: z.object({}),",
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

    expect(exitCode).toBe(1);
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
    const original = await readFile(filePath, "utf8");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("exits 1 when the project's config fails to load", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir: fixture("invalid-config-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
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

    expect(exitCode).toBe(1);
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
