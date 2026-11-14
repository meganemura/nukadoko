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

// zod's own text for these two mistakes ("(root): expected object,
// received undefined") names neither the cause nor the fix.

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

const VOID = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  description: "A Given that only changes the world, under a stub returns.",',
  "  args: z.object({}),",
  "  returns: z.object({}),",
  "  // @ts-expect-error run returns nothing although returns is declared",
  "  run() {},",
  "});",
  "",
].join("\n");

const UNAWAITED = [
  'import { defineStep, z } from "nukadoko";',
  "async function exitCodeOf() {",
  "  return 0;",
  "}",
  "export default defineStep({",
  '  description: "Calls an async helper without await.",',
  "  args: z.object({}),",
  "  returns: z.object({ exitCode: z.number() }),",
  "  run() {",
  "    // @ts-expect-error the helper is not awaited",
  "    return { exitCode: exitCodeOf() };",
  "  },",
  "});",
  "",
].join("\n");

describe("nuka do: returns failures that say what happened", () => {
  let rootDir: string;

  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(path.join(rootDir, "features", "steps", "zz-void.ts"), VOID);
    await writeFile(path.join(rootDir, "features", "steps", "zz-unawaited.ts"), UNAWAITED);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function error(step: string): Promise<unknown> {
    const stdout = createCaptureSink();
    await runCli(["do", step, "--args", "{}"], { rootDir, stdout, stderr: createCaptureSink() });
    return (JSON.parse(stdout.text()) as { error: unknown }).error;
  }

  it("says run returned nothing when returns is declared", async () => {
    expect(await error("zz-void")).toEqual({
      message:
        "returns validation failed: this step declares returns, but run returned nothing; " +
        "return a value that matches returns, or delete returns if no later step reads from this one",
      kind: "result_invalid",
    });
  });

  it("says a key holds a Promise, beside zod's text", async () => {
    expect(await error("zz-unawaited")).toEqual({
      message:
        "returns validation failed: exitCode: Invalid input: expected number, received Promise; " +
        "exitCode holds a Promise: await the call inside run",
      kind: "result_invalid",
    });
  });
});

describe("parseStepReturns names every key that holds a Promise", () => {
  it("adds the hint for exactly the keys whose value is a Promise", () =>
    hegel.test((tc) => {
      const keys = [...new Set(tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 5, alphabet: "kmnx" }), { minSize: 1, maxSize: 4 })))];
      const promised = keys.map(() => tc.draw(gs.booleans()));
      const step = defineStep({
        description: "d",
        args: z.object({}),
        returns: z.object(Object.fromEntries(keys.map((key) => [key, z.string()]))),
        run() {
          return {};
        },
      });
      const value = Object.fromEntries(keys.map((key, index) => [key, promised[index] ? Promise.resolve("a") : 1]));
      const wrong = keys.map((key, index) => `${key}: Invalid input: expected string, received ${promised[index] ? "Promise" : "number"}`);
      const held = keys.filter((_, index) => promised[index]);
      const hint =
        held.length === 0 ? "" : `; ${held.join(", ")} ${held.length === 1 ? "holds a Promise" : "hold Promises"}: await the call inside run`;
      expect(parseStepReturns(step, value)).toEqual({
        success: false,
        message: `returns validation failed: ${wrong.join("; ")}${hint}`,
      });
    }));
});
