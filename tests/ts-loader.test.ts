import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { typeScriptSpecifier } from "../src/config/ts-loader.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

describe("typeScriptSpecifier", () => {
  it("maps a path specifier's JavaScript extension to its TypeScript one and keeps the suffix", () =>
    hegel.test((tc) => {
      const prefix = tc.draw(gs.sampledFrom(["./", "../", "/abs/", "file:///abs/"]));
      const stem = tc.draw(gs.text({ minSize: 1, maxSize: 12 })).replace(/[?#\n]/g, "x");
      const [js, ts] = tc.draw(gs.sampledFrom([[".js", ".ts"], [".mjs", ".mts"], [".cjs", ".cts"]] as const));
      const suffix = tc.draw(gs.sampledFrom(["", "?nukadoko-namespace=1", "#part"]));
      expect(typeScriptSpecifier(`${prefix}${stem}${js}${suffix}`)).toBe(`${prefix}${stem}${ts}${suffix}`);
    }));

  it("leaves a package name or a builtin alone", () =>
    hegel.test((tc) => {
      const name = tc.draw(gs.sampledFrom(["zod", "nukadoko/compat", "node:path", "@scope/pkg/index.js", "pkg/x.js"]));
      expect(typeScriptSpecifier(name)).toBeNull();
    }));

  it("leaves a specifier with another extension alone", () => {
    expect(typeScriptSpecifier("./step.ts")).toBeNull();
    expect(typeScriptSpecifier("./data.json")).toBeNull();
  });
});

const producer = [
  'import { z } from "zod";',
  'import { defineStep } from "nukadoko";',
  "",
  "export default defineStep({",
  '  pattern: "I make a number",',
  '  description: "Makes a number",',
  "  args: z.object({}),",
  "  returns: z.object({ n: z.number() }),",
  "  async run() {",
  "    return { n: 7 };",
  "  },",
  "});",
  "",
].join("\n");

const consumer = (specifier: string, pattern: string) =>
  [
    'import { z } from "zod";',
    'import { defineStep } from "nukadoko";',
    `import makeNumber from ${JSON.stringify(specifier)};`,
    "",
    "export default defineStep({",
    `  pattern: ${JSON.stringify(pattern)},`,
    '  description: "Reads the number",',
    "  args: z.object({ n: z.number() }),",
    "  returns: z.object({}),",
    "  mutates: false,",
    '  from: { n: [makeNumber, "n"] },',
    "  async run({}, { n }) {",
    '    if (n !== 7) throw new Error(`got ${n}`);',
    "    return {};",
    "  },",
    "});",
    "",
  ].join("\n");

describe("a step file that imports another by its .ts name", () => {
  async function project(): Promise<string> {
    await ensureNukadokoShim();
    const dir = await createEmptyTempDir();
    await mkdir(path.join(dir, "features", "steps"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
    await writeFile(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n');
    await writeFile(path.join(dir, "features", "steps", "make-number.ts"), producer);
    await writeFile(path.join(dir, "features", "steps", "by-ts.ts"), consumer("./make-number.ts", "the ts import reads it"));
    await writeFile(path.join(dir, "features", "steps", "by-js.ts"), consumer("./make-number.js", "the js import reads it"));
    await writeFile(
      path.join(dir, "features", "number.feature"),
      [
        "Feature: number",
        "  Scenario: both spellings",
        "    When I make a number",
        "    Then the ts import reads it",
        "    And the js import reads it",
        "",
      ].join("\n"),
    );
    return dir;
  }

  it("discovers it, and `from` reaches the same Step object under either spelling", async () => {
    const dir = await project();
    try {
      const { vocabulary } = await discoverSteps(dir, "features");
      expect([...vocabulary.keys()].sort()).toEqual(["by-js", "by-ts", "make-number"]);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run"], { rootDir: dir, stdout, stderr });
      expect(stderr.text()).toContain("1 scenario: 1 passed, 0 failed");
      expect(exitCode).toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  });
});
