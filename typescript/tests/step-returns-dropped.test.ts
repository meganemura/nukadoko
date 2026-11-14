import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/run-cli.js";
import { defineStep } from "../src/step/define-step.js";
import { parseStepReturns } from "../src/step/parse-returns.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// A step that declares no returns used to have its returned object
// stripped to {} by the default schema, so the value vanished from the
// step record while the step passed.

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

const PROBE = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the probe reads the envelope",',
  '  description: "A step that returns evidence but declares no returns.",',
  "  args: z.object({}),",
  "  mutates: false,",
  "  run() {",
  '    return { envelope: "sealed", proof: 1 };',
  "  },",
  "});",
  "",
].join("\n");

const QUIET = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the quiet step checks",',
  '  description: "A step that returns nothing.",',
  "  args: z.object({}),",
  "  mutates: false,",
  "  run() {},",
  "});",
  "",
].join("\n");

const FEATURE = [
  "Feature: evidence",
  "",
  "  Scenario: the probe",
  "    When the probe reads the envelope",
  "",
  "  Scenario: the quiet step",
  "    When the quiet step checks",
  "",
].join("\n");

const MESSAGE =
  "returns validation failed: this step declares no returns, so envelope, proof would be dropped from the step record; " +
  "declare returns with those keys, or stop returning them";

describe("a step with no returns that returns an object", () => {
  let rootDir: string;

  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(path.join(rootDir, "features", "steps", "probe.ts"), PROBE);
    await writeFile(path.join(rootDir, "features", "steps", "quiet.ts"), QUIET);
    await writeFile(path.join(rootDir, "features", "evidence.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka do fails it as result_invalid, naming the keys", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "probe", "--args", "{}"], { rootDir, stdout, stderr: createCaptureSink() });
    const record = JSON.parse(stdout.text()) as { status: string; error: unknown };

    expect(exitCode).toBe(1);
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ message: MESSAGE, kind: "result_invalid" });
  });

  it("nuka run fails that scenario and passes the one whose step returns nothing", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
    const run = JSON.parse(stdout.text()) as {
      scenarios: { scenario: string; status: string }[];
    };

    expect(exitCode).toBe(1);
    expect(run.scenarios.map((entry) => [entry.scenario, entry.status])).toEqual([
      ["the probe", "failed"],
      ["the quiet step", "passed"],
    ]);
  });
});

describe("parseStepReturns for a step with no returns", () => {
  const step = defineStep({ description: "d", args: z.object({}), run() {} });

  it("refuses every non-empty object, naming each key in order, and keeps nothing or {} as {}", () =>
    hegel.test((tc) => {
      const keys = [...new Set(tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 6, alphabet: "abc_" }), { minSize: 1, maxSize: 4 })))];
      const value = Object.fromEntries(keys.map((key, index) => [key, index]));
      const one = keys.length === 1;
      expect(parseStepReturns(step, value)).toEqual({
        success: false,
        message:
          `returns validation failed: this step declares no returns, so ${keys.join(", ")} would be dropped from the step record; ` +
          `declare returns with ${one ? "that key" : "those keys"}, or stop returning ${one ? "it" : "them"}`,
      });
      expect(parseStepReturns(step, tc.draw(gs.sampledFrom([undefined, {}])))).toEqual({ success: true, data: {} });
    }));

  it("keeps zod's text for a step that declares a strict returns of its own", () => {
    const declared = defineStep({
      description: "d",
      args: z.object({}),
      returns: z.strictObject({}),
      run() {
        return {};
      },
    });
    expect(parseStepReturns(declared, { proof: 1 })).toEqual({
      success: false,
      message: 'returns validation failed: (root): Unrecognized key: "proof"',
    });
  });
});
