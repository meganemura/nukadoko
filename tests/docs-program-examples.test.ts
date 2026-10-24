import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { loadProgram } from "../src/config/load-program.js";
import { createCaptureSink, removeTempDir, repoRoot, testsDir } from "./helpers/fixtures.js";

// Responsibility: every whole `nukadoko.program.ts` the reader-facing docs
// show loads, and `nuka check` passes it for each world it can start, the
// default world and each environment. The spec's own Environments example
// once failed `nuka check`: its staging environment swapped `serve` for a
// `url` and kept the top level's `PORT: "{port}"`, which a url world had no
// value for.
//
// A block is a whole program file when it holds `export default
// defineProgram(`. A fragment (an `environments` entry alone) is not read.
// The block is written as it is, with `"nukadoko"` pointed at this
// checkout's `src/`; a function it calls but does not define (`seedAdmin`)
// is not called, since nothing here starts a world.

const DOCS = [
  "README.md",
  "README.ja.md",
  "docs/spec.md",
  "docs/spec.ja.md",
  "docs/migration.md",
  "docs/migration.ja.md",
  "skills/nukadoko/references/program.md",
];

interface ProgramBlock {
  readonly file: string;
  readonly line: number;
  readonly body: string;
}

function programBlocks(file: string): ProgramBlock[] {
  const lines = readFileSync(path.join(repoRoot, file), "utf8").split("\n");
  const blocks: ProgramBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)```ts\s*$/.exec(lines[index]!);
    if (open === null) continue;
    const indent = open[1]!.length;
    const start = index;
    const body: string[] = [];
    for (index++; index < lines.length && lines[index]!.trim() !== "```"; index++) body.push(lines[index]!.slice(indent));
    const text = body.join("\n");
    if (text.includes("export default defineProgram(")) blocks.push({ file, line: start + 1, body: text });
  }
  return blocks;
}

const tempRoot = path.join(testsDir, ".tmp-fixtures");
const made: string[] = [];

afterAll(async () => {
  for (const dir of made) await removeTempDir(dir);
});

function projectFor(block: ProgramBlock): string {
  mkdirSync(tempRoot, { recursive: true });
  const rootDir = mkdtempSync(path.join(tempRoot, "docs-program-"));
  made.push(rootDir);
  // tests/.tmp-fixtures/<dir>/ is three levels below the repository root.
  writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), 'export * from "../../../src/index.js";\n');
  writeFileSync(path.join(rootDir, "nukadoko.config.ts"), 'import { defineConfig } from "./nukadoko-shim.js";\nexport default defineConfig({});\n');
  // One step and one feature that binds it, so the check has a project to
  // read and every finding left is the program file's.
  mkdirSync(path.join(rootDir, "features", "steps"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "features", "steps", "noop.ts"),
    [
      'import { z } from "zod";',
      'import { defineStep } from "../../nukadoko-shim.js";',
      'export default defineStep({ pattern: "nothing happens", description: "does nothing", args: z.object({}), mutates: false, async run() {} });',
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(rootDir, "features", "noop.feature"), "Feature: noop\n\n  Scenario: noop\n    When nothing happens\n");
  const imported = block.body.includes('from "nukadoko"') ? block.body : `import { defineProgram } from "nukadoko";\n${block.body}`;
  writeFileSync(path.join(rootDir, "nukadoko.program.ts"), `${imported.replaceAll('from "nukadoko"', 'from "./nukadoko-shim.js"')}\n`);
  return rootDir;
}

describe("the program files the docs show", () => {
  const blocks = DOCS.flatMap(programBlocks);

  it("are found in the spec and the README", () => {
    expect(blocks.filter((block) => block.file === "docs/spec.md").length).toBeGreaterThanOrEqual(4);
    expect(blocks.some((block) => block.file === "README.md")).toBe(true);
  });

  for (const block of blocks) {
    it(`${block.file}:${block.line} loads and passes nuka check in every world it can start`, async () => {
      const rootDir = projectFor(block);
      const program = await loadProgram(rootDir);
      const envs = ["default", ...Object.keys(program?.program.environments ?? {})];
      const stdout = createCaptureSink();
      const exitCode = await runCli(["check", "--json", ...envs.flatMap((name) => ["--env", name])], { rootDir, stdout, stderr: createCaptureSink() });
      const findings = (JSON.parse(stdout.text()) as { findings: { severity: string; code: string; message: string }[] }).findings;
      expect(findings.filter((finding) => finding.severity === "error" || finding.severity === "refused")).toEqual([]);
      expect(exitCode).toBe(0);
    });
  }
});
