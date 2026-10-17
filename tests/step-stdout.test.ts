import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEmptyTempDir, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: the stdout contract of `nuka do` and `nuka run` when
// project code writes to the process stdout: a step body, a hook, a
// BeforeAll or AfterAll, a fixture, a World constructor, a step file at
// load time, and a step that keeps running after its timeout. An
// in-process `runCli` call passes its own sink, so none of these writes
// shares a stream with the record and the bug cannot show up. These tests
// spawn the CLI the way a caller does, and parse what that process
// actually prints.

const TYPED_LINE = "debug line from the step";
const TYPED_PARTIAL = "partial stdout write";
const COMPAT_LINE = "debug line from the compat step";
const COMPAT_PARTIAL = "partial compat stdout write";

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function writeChattyProject(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
  // `"type": "module"` so Node loads this project's .ts config and steps as
  // ESM directly, with no reparse warning on the stderr this test reads.
  await writeFile(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "chatty-stdout", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    `import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({});\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko-shim.ts"),
    `export * from "../../../src/index.js";\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko-compat-shim.ts"),
    `export * from "../../../src/compat/index.js";\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "steps", "chatty.ts"),
    `import { z } from "zod";\n` +
      `import { defineStep } from "../../nukadoko-shim.js";\n\n` +
      `export default defineStep({\n` +
      `  pattern: "a chatty step runs",\n` +
      `  description: "Write to the process stdout",\n` +
      `  args: z.object({}),\n` +
      `  returns: z.object({ ok: z.boolean() }),\n` +
      `  mutates: false,\n` +
      `  run() {\n` +
      `    console.log(${JSON.stringify(TYPED_LINE)});\n` +
      `    process.stdout.write(${JSON.stringify(TYPED_PARTIAL)});\n` +
      `    return { ok: true };\n` +
      `  },\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "steps", "legacy-chatty.ts"),
    `import { When } from "../../nukadoko-compat-shim.js";\n\n` +
      `When("a legacy chatty step runs", function () {\n` +
      `  console.log(${JSON.stringify(COMPAT_LINE)});\n` +
      `  process.stdout.write(${JSON.stringify(COMPAT_PARTIAL)});\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "typed.feature"),
    `Feature: Typed step writes to stdout\n\n` +
      `  Scenario: a typed step writes to stdout\n` +
      `    When a chatty step runs\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "compat.feature"),
    `Feature: Compat step writes to stdout\n\n` +
      `  Scenario: a compat step writes to stdout\n` +
      `    When a legacy chatty step runs\n`,
  );
}

async function runNuka(
  rootDir: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.join(repoRoot, "src", "cli.ts");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...sourceNodeArgs, cliPath, ...args], {
      cwd: rootDir,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number | string };
    const code = failed.code;
    return {
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : "",
      exitCode: typeof code === "number" ? code : 1,
    };
  }
}

function expectParseableJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

function expectParseableNdjson(stdout: string): unknown[] {
  const lines = nonEmptyLines(stdout);
  return lines.map((line) => JSON.parse(line));
}

describe("step stdout stays off the record stream", () => {
  it("nuka do prints one JSON step record when the step writes to stdout", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      await writeChattyProject(rootDir);
      const { stdout, stderr, exitCode } = await runNuka(rootDir, ["do", "chatty", "--args", "{}"]);

      expect(exitCode, stderr).toBe(0);
      const record = expectParseableJson(stdout) as { step: string; status: string };
      expect(record.step).toBe("chatty");
      expect(record.status).toBe("ok");
      expect(stdout).not.toContain(TYPED_LINE);
      expect(stdout).not.toContain(TYPED_PARTIAL);
      expect(stderr).toContain(TYPED_LINE);
      expect(stderr).toContain(TYPED_PARTIAL);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka run prints one NDJSON record per scenario when steps write to stdout", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      await writeChattyProject(rootDir);
      const { stdout, stderr, exitCode } = await runNuka(rootDir, [
        "run",
        "features/typed.feature",
        "features/compat.feature",
        "--quiet",
      ]);

      expect(exitCode, stderr).toBe(0);
      const records = expectParseableNdjson(stdout) as { status: string }[];
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.status === "passed")).toBe(true);
      expect(stdout).not.toContain(TYPED_LINE);
      expect(stdout).not.toContain(TYPED_PARTIAL);
      expect(stdout).not.toContain(COMPAT_LINE);
      expect(stdout).not.toContain(COMPAT_PARTIAL);
      expect(stderr).toContain(TYPED_LINE);
      expect(stderr).toContain(TYPED_PARTIAL);
      expect(stderr).toContain(COMPAT_LINE);
      expect(stderr).toContain(COMPAT_PARTIAL);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka run --concurrency keeps worker stdout parseable when steps write to stdout", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      await writeChattyProject(rootDir);
      const { stdout, stderr, exitCode } = await runNuka(rootDir, [
        "run",
        "features/typed.feature",
        "features/compat.feature",
        "--quiet",
        "--concurrency",
        "2",
      ]);

      expect(exitCode, stderr).toBe(0);
      const records = expectParseableNdjson(stdout) as { status: string }[];
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.status === "passed")).toBe(true);
      expect(stderr).not.toContain("unreadable line");
      expect(stdout).not.toContain(TYPED_LINE);
      expect(stdout).not.toContain(COMPAT_LINE);
      expect(stderr).toContain(TYPED_LINE);
      expect(stderr).toContain(COMPAT_LINE);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

const NOISE = [
  "MODULE_LOAD",
  "BEFORE_ALL",
  "AFTER_ALL",
  "WORLD_CTOR",
  "BEFORE_HOOK",
  "AFTER_HOOK",
  "SCENARIO_FIXTURE_SETUP",
  "SCENARIO_FIXTURE_TEARDOWN",
  "PROCESS_FIXTURE_SETUP",
  "PROCESS_FIXTURE_TEARDOWN",
  "LATE_WRITE",
] as const;

// Every write is partial (no newline), so a leak glues onto the next record
// and breaks the line it lands in. `late.feature` times its first step out
// at 100ms; that step writes 250ms after it began, while the second
// scenario waits in a 600ms fixture setup, after any per-step diversion has
// been put back.
async function writeNoisyProject(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
  await mkdir(path.join(rootDir, "features", "support"), { recursive: true });
  await writeFile(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "noisy-stdout", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko-shim.ts"),
    `export * from "../../../src/index.js";\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko-compat-shim.ts"),
    `export * from "../../../src/compat/index.js";\n`,
  );
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    `import { defineConfig, defineFixtures } from "./nukadoko-shim.js";\n\n` +
      `export default defineConfig({\n` +
      `  fixtures: defineFixtures({\n` +
      `    noisyScenario: async ({}, use) => {\n` +
      `      process.stdout.write("SCENARIO_FIXTURE_SETUP");\n` +
      `      await use({});\n` +
      `      process.stdout.write("SCENARIO_FIXTURE_TEARDOWN");\n` +
      `    },\n` +
      `    noisyProcess: [\n` +
      `      async ({}, use) => {\n` +
      `        process.stdout.write("PROCESS_FIXTURE_SETUP");\n` +
      `        await use({});\n` +
      `        process.stdout.write("PROCESS_FIXTURE_TEARDOWN");\n` +
      `      },\n` +
      `      { scope: "process" },\n` +
      `    ],\n` +
      `    slowSetup: async ({}, use) => {\n` +
      `      await new Promise((resolve) => setTimeout(resolve, 600));\n` +
      `      await use({});\n` +
      `    },\n` +
      `  }),\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "steps", "noisy.ts"),
    `import { z } from "zod";\n` +
      `import { defineStep } from "../../nukadoko-shim.js";\n\n` +
      `process.stdout.write("MODULE_LOAD");\n\n` +
      `export default defineStep({\n` +
      `  pattern: "a step uses noisy fixtures",\n` +
      `  description: "Names fixtures that write to the process stdout",\n` +
      `  args: z.object({}),\n` +
      `  returns: z.object({}),\n` +
      `  mutates: false,\n` +
      `  run({ noisyScenario, noisyProcess }: any) {\n` +
      `    void noisyScenario;\n` +
      `    void noisyProcess;\n` +
      `    return {};\n` +
      `  },\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "steps", "outlive.ts"),
    `import { z } from "zod";\n` +
      `import { defineStep } from "../../nukadoko-shim.js";\n\n` +
      `export default defineStep({\n` +
      `  pattern: "a step outlives its timeout",\n` +
      `  description: "Writes to the process stdout after its deadline",\n` +
      `  args: z.object({}),\n` +
      `  returns: z.object({}),\n` +
      `  mutates: false,\n` +
      `  timeout: 100,\n` +
      `  async run() {\n` +
      `    await new Promise((resolve) => setTimeout(resolve, 250));\n` +
      `    process.stdout.write("LATE_WRITE");\n` +
      `    return {};\n` +
      `  },\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "steps", "slow.ts"),
    `import { z } from "zod";\n` +
      `import { defineStep } from "../../nukadoko-shim.js";\n\n` +
      `export default defineStep({\n` +
      `  pattern: "a step waits on a slow fixture",\n` +
      `  description: "Names a fixture whose setup takes 600ms",\n` +
      `  args: z.object({}),\n` +
      `  returns: z.object({}),\n` +
      `  mutates: false,\n` +
      `  run({ slowSetup }: any) {\n` +
      `    void slowSetup;\n` +
      `    return {};\n` +
      `  },\n` +
      `});\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "support", "hooks.ts"),
    `import { After, AfterAll, Before, BeforeAll, setWorldConstructor, World, type IWorldOptions } from "../../nukadoko-compat-shim.js";\n\n` +
      `class NoisyWorld extends World {\n` +
      `  constructor(options: IWorldOptions) {\n` +
      `    super(options);\n` +
      `    process.stdout.write("WORLD_CTOR");\n` +
      `  }\n` +
      `}\n\n` +
      `setWorldConstructor(NoisyWorld);\n` +
      `BeforeAll(function () { process.stdout.write("BEFORE_ALL"); });\n` +
      `AfterAll(function () { process.stdout.write("AFTER_ALL"); });\n` +
      `Before(function () { process.stdout.write("BEFORE_HOOK"); });\n` +
      `After(function () { process.stdout.write("AFTER_HOOK"); });\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "noisy.feature"),
    `Feature: Project code writes to stdout\n\n` +
      `  Scenario: fixtures and hooks write to stdout\n` +
      `    When a step uses noisy fixtures\n`,
  );
  await writeFile(
    path.join(rootDir, "features", "late.feature"),
    `Feature: A timed-out step writes late\n\n` +
      `  Scenario: a step outlives its timeout\n` +
      `    When a step outlives its timeout\n\n` +
      `  Scenario: the next scenario waits in fixture setup\n` +
      `    When a step waits on a slow fixture\n`,
  );
}

describe("project stdout outside step bodies stays off the record stream", () => {
  for (const concurrency of ["1", "2"]) {
    it(`nuka run --concurrency ${concurrency} prints only records when hooks, fixtures, and a late step write to stdout`, async () => {
      const rootDir = await createEmptyTempDir();
      try {
        await writeNoisyProject(rootDir);
        const { stdout, stderr, exitCode } = await runNuka(rootDir, [
          "run",
          "features/noisy.feature",
          "features/late.feature",
          "--quiet",
          "--concurrency",
          concurrency,
        ]);

        expect(exitCode, stderr).toBe(1);
        expect(stderr).not.toContain("unreadable line");
        const records = expectParseableNdjson(stdout) as { scenario: string; status: string }[];
        expect(
          records.map((record) => `${record.scenario}: ${record.status}`).sort(),
        ).toEqual([
          "a step outlives its timeout: failed",
          "fixtures and hooks write to stdout: passed",
          "the next scenario waits in fixture setup: passed",
        ]);
        for (const marker of NOISE) {
          expect(stdout, marker).not.toContain(marker);
          expect(stderr, marker).toContain(marker);
        }
      } finally {
        await removeTempDir(rootDir);
      }
    }, 60_000);
  }

  it("nuka do prints one JSON step record when its fixtures write to stdout", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      await writeNoisyProject(rootDir);
      const { stdout, stderr, exitCode } = await runNuka(rootDir, ["do", "noisy", "--args", "{}"]);

      expect(exitCode, stderr).toBe(0);
      const record = expectParseableJson(stdout) as { step: string; status: string };
      expect(record.step).toBe("noisy");
      expect(record.status).toBe("ok");
      for (const marker of ["MODULE_LOAD", "SCENARIO_FIXTURE_SETUP", "SCENARIO_FIXTURE_TEARDOWN"]) {
        expect(stdout, marker).not.toContain(marker);
        expect(stderr, marker).toContain(marker);
      }
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
