import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRoot, testsDir } from "./helpers/fixtures.js";

// Responsibility: the types a project sees for `scratch`, through the
// published "nukadoko" package (dist/, built before every test run). Each
// case is its own small project compiled by its own `tsc`, because a
// `declare module "nukadoko"` augmentation changes the types for the whole
// program it is compiled in.
//
// The second case is the one this shape exists for: projects declared their
// own `scratch` fixture, with a narrower type, before the builtin existed.
// Had the builtin been a `StepFixtures` member, that declaration would stop
// compiling (TS2717).

const execFileAsync = promisify(execFile);
const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
  },
  include: ["**/*.ts"],
});

const STEP_PREAMBLE = 'import { defineStep, z } from "nukadoko";\n';

async function typecheck(dir: string, files: Record<string, string>): Promise<{ code: number; output: string }> {
  await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  try {
    const { stdout } = await execFileAsync(tsc, ["-p", dir]);
    return { code: 0, output: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? 1, output: failed.stdout ?? "" };
  }
}

describe("scratch types through the published package", () => {
  let dir: string;

  beforeEach(async () => {
    // Under tests/ so "nukadoko" resolves to this package by its own name.
    const parent = path.join(testsDir, ".tmp-fixtures");
    await mkdir(parent, { recursive: true });
    dir = await mkdtemp(path.join(parent, "scratch-types-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types the builtin for a project whose config declares nothing", async () => {
    const result = await typecheck(dir, {
      "nukadoko.config.ts": 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n',
      "features/steps/copy.ts":
        STEP_PREAMBLE +
        "export default defineStep({\n" +
        '  description: "copies",\n' +
        "  args: z.object({}),\n" +
        "  returns: z.object({ copy: z.string(), empty: z.string() }),\n" +
        "  async run({ scratch }) {\n" +
        '    return { copy: await scratch.copy("seed"), empty: scratch.dir() };\n' +
        "  },\n" +
        "});\n",
    });

    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses a member the builtin does not have, so the first case is a real check", async () => {
    const result = await typecheck(dir, {
      "features/steps/wrong.ts":
        STEP_PREAMBLE +
        "export default defineStep({\n" +
        '  description: "wrong",\n' +
        "  args: z.object({}),\n" +
        "  returns: z.object({}),\n" +
        "  async run({ scratch }) {\n" +
        "    scratch.remove();\n" +
        "    return {};\n" +
        "  },\n" +
        "});\n",
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("remove");
  });

  it("keeps a project's own scratch declaration compiling, and its type wins", async () => {
    const result = await typecheck(dir, {
      "nukadoko.config.ts":
        'import { defineConfig, defineFixtures } from "nukadoko";\n' +
        "export interface Scratch {\n  dir(prefix: string): string;\n}\n" +
        "const fixtures = defineFixtures({\n" +
        "  scratch: async ({}, use) => {\n" +
        '    await use({ dir: (prefix: string) => prefix });\n' +
        "  },\n" +
        "});\n" +
        'declare module "nukadoko" {\n  interface StepFixtures {\n    scratch: Scratch;\n  }\n}\n' +
        "export default defineConfig({ fixtures });\n",
      "features/steps/own.ts":
        STEP_PREAMBLE +
        "export default defineStep({\n" +
        '  description: "own",\n' +
        "  args: z.object({}),\n" +
        "  returns: z.object({ dir: z.string() }),\n" +
        "  async run({ scratch }) {\n" +
        '    const dir: string = scratch.dir("x");\n' +
        "    // @ts-expect-error the project's own Scratch has no copy\n" +
        '    void scratch.copy("seed");\n' +
        "    return { dir };\n" +
        "  },\n" +
        "});\n",
    });

    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  });
});
