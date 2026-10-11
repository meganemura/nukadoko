import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: the stdout contract of `nuka do` and `nuka run` when a
// step writes to the process stdout. An in-process `runCli` call passes
// its own sink, so a `console.log` in the step never shares a stream with
// the record and the bug cannot show up. These tests spawn the CLI the
// way a caller does, and parse what that process actually prints.

const TYPED_LINE = "debug line from the step";
const TYPED_PARTIAL = "partial stdout write";
const COMPAT_LINE = "debug line from the compat step";
const COMPAT_PARTIAL = "partial compat stdout write";

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function writeChattyProject(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
  // `"type": "module"` so tsx loads this project's .ts config and steps as
  // ESM. A project with no package.json is read as CommonJS, and the config
  // import fails before a step ever runs.
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
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const cliPath = path.join(repoRoot, "src", "cli.ts");
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, ...args], { cwd: rootDir });
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
