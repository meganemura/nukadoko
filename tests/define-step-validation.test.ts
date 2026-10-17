import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: a .js step file is not type-checked, so defineStep is the
// only place a malformed definition can be refused. These tests pin the two
// ways that refusal has to show up: nuka check names it as
// step-file-import-failed (the import throws while discovery loads the
// file), and a timeout Node's timer would clamp is that same report rather
// than a step record whose error says the step timed out.

const MISSING_ARGS = [
  'import { defineStep, z } from "../../nukadoko-shim.js";',
  "",
  "export default defineStep({",
  '  pattern: "a thing happens",',
  '  description: "broken args",',
  "  returns: z.object({}),",
  "  async run() {",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

const PLAIN_RETURNS = [
  'import { defineStep, z } from "../../nukadoko-shim.js";',
  "",
  "export default defineStep({",
  '  pattern: "a thing happens",',
  '  description: "broken returns",',
  "  args: z.object({}),",
  '  returns: { id: "string" },',
  "  async run() {",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

const BAD_TIMEOUT = [
  'import { defineStep, z } from "../../nukadoko-shim.js";',
  "",
  "export default defineStep({",
  '  pattern: "a thing happens",',
  '  description: "bad timeout",',
  "  args: z.object({}),",
  "  returns: z.object({}),",
  "  timeout: Infinity,",
  "  async run() {",
  "    await new Promise(() => {});",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

const VALID = [
  'import { defineStep, z } from "../../nukadoko-shim.js";',
  "",
  "export default defineStep({",
  '  description: "valid",',
  "  args: z.object({}),",
  "  returns: z.object({}),",
  "  timeout: 1000,",
  "  async run() {",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

describe("defineStep validation reaches nuka check and nuka do", () => {
  let rootDir: string;

  afterEach(async () => {
    if (rootDir) {
      await removeTempDir(rootDir);
    }
  });

  async function writeProject(stepFile: string, source: string): Promise<void> {
    rootDir = await createEmptyTempDir();
    const shimTarget = path.join(repoRoot, "src", "index.js");
    let relative = path.relative(rootDir, shimTarget).split(path.sep).join("/");
    if (!relative.startsWith(".")) {
      relative = `./${relative}`;
    }
    await writeFile(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(relative)};\n`);
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({});\n',
    );
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "features", "steps", stepFile), source);
  }

  async function checkReport(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    errors: Array<{ code: string; message: string; file?: string }>;
  }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });
    let errors: Array<{ code: string; message: string; file?: string }> = [];
    try {
      errors = (JSON.parse(stdout.text()) as { errors: typeof errors }).errors;
    } catch {
      throw new Error(`nuka check did not return a report.\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`);
    }
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), errors };
  }

  it("reports a step with no args schema as step-file-import-failed, not a bare TypeError", async () => {
    await writeProject("broken.js", MISSING_ARGS);
    const report = await checkReport();
    expect(report.exitCode).toBe(1);
    const finding = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(finding?.file).toBe("features/steps/broken.js");
    expect(finding?.message).toContain("args must be a zod schema");
    expect(report.stderr).not.toContain("Cannot read properties of undefined");
    expect(report.stdout).not.toContain("Cannot read properties of undefined");
  });

  it("reports a step whose returns is a plain value, not a schema, as step-file-import-failed", async () => {
    await writeProject("broken.js", PLAIN_RETURNS);
    const report = await checkReport();
    expect(report.exitCode).toBe(1);
    const finding = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(finding?.file).toBe("features/steps/broken.js");
    expect(finding?.message).toContain("returns must be a zod schema");
  });

  it("reports a timeout setTimeout would clamp as that timeout, not as a step failure", async () => {
    await writeProject("bad-timeout.js", BAD_TIMEOUT);
    const report = await checkReport();
    expect(report.exitCode).toBe(1);
    const finding = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(finding?.message).toContain(
      "timeout must be a finite number of milliseconds greater than 0 and at most 2147483647",
    );
    expect(finding?.message).not.toContain("timed out after");
  });

  it("does not record a clamped timeout as the step timing out", async () => {
    await writeProject("bad-timeout.js", BAD_TIMEOUT);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "bad-timeout", "--args", "{}"], { rootDir, stdout, stderr });
    const combined = `${stdout.text()}\n${stderr.text()}`;
    expect(exitCode, combined).toBe(2);
    expect(combined).toContain("timeout must be a finite number of milliseconds");
    expect(combined).not.toContain("timed out after");
    expect(combined).not.toContain('"kind": "timeout"');
  });

  it("still runs a valid step", async () => {
    await writeProject("valid.js", VALID);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "valid", "--args", "{}"], { rootDir, stdout, stderr });
    expect(exitCode, `${stdout.text()}\n${stderr.text()}`).toBe(0);
    expect(stdout.text()).toContain('"status": "passed"');
  });
});
