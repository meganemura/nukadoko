import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/check/analyze.js";
import { runCli } from "../src/cli/run-cli.js";
import { analyzeTend } from "../src/tend/analyze.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an oath reaches the same check and run path a feature
// file does. Drift is `undefined-step` on the Markdown line. Narration is
// not a finding. A Markdown file that `oaths` does not name is not loaded.

const STEP = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the list includes {item:string}",',
  '  description: "A list entry the oath names.",',
  "  args: z.object({ item: z.string() }),",
  "  returns: z.object({ item: z.string() }),",
  "  mutates: false,",
  "  run({}, args) {",
  "    return { item: args.item };",
  "  },",
  "});",
  "",
].join("\n");

async function writeProject(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
}

function config(oaths: readonly string[]): string {
  return ['import { defineConfig } from "nukadoko";', "", `export default defineConfig({ oaths: ${JSON.stringify(oaths)} });`, ""].join(
    "\n",
  );
}

describe("markdown oaths", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports an unmatched sentence as undefined-step on its line", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config(["docs/list.md"]),
      "features/steps/includes.ts": STEP,
      "docs/list.md": "# List\n\nThe cupboard holds a secret.\n",
    });

    const report = await analyzeProject(rootDir);
    const drift = report.errors.filter((issue) => issue.code === "undefined-step");
    expect(drift).toEqual([
      expect.objectContaining({
        file: "docs/list.md",
        line: 3,
        message: expect.stringContaining("The cupboard holds a secret"),
      }),
    ]);
  });

  it("does not report a blockquote", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config(["docs/list.md"]),
      "features/steps/includes.ts": STEP,
      "docs/list.md": '> This sentence matches nothing.\nGiven the list includes "milk".\n',
    });

    const report = await analyzeProject(rootDir);
    expect(report.errors).toEqual([]);
  });

  it("reports a missing oath path as feature-parse-error", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config(["docs/missing.md"]),
      "features/steps/includes.ts": STEP,
    });

    const report = await analyzeProject(rootDir);
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: "feature-parse-error",
        file: "docs/missing.md",
        message: expect.stringContaining("does not exist"),
      }),
    ]);
  });

  it("does not load a Markdown file under featuresDir unless oaths names it", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config([]),
      "features/steps/includes.ts": STEP,
      "features/noise.md": "This sentence matches nothing.\n",
    });

    const report = await analyzeProject(rootDir);
    expect(report.errors.filter((issue) => issue.file === "features/noise.md")).toEqual([]);
  });

  it("treats a step bound only by an oath as bound", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config(["docs/list.md"]),
      "features/steps/includes.ts": STEP,
      "docs/list.md": 'Given the list includes "milk".\n',
    });

    const report = await analyzeTend(rootDir);
    expect(report.notes.filter((issue) => issue.code === "pattern-unbound")).toEqual([]);
  });

  it("runs an explicit Markdown path and writes a passed scenario record", async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeProject(rootDir, {
      "nukadoko.config.ts": config([]),
      "features/steps/includes.ts": STEP,
      "docs/list.md": 'Given the list includes "milk".\n',
      "docs/noise.md": "This sentence matches nothing.\n",
    });

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "docs/list.md"], { rootDir, stdout, stderr });
    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string; feature: string });
    expect(records).toEqual([expect.objectContaining({ status: "passed", feature: "docs/list.md" })]);
    expect(exitCode).toBe(0);
  });
});
