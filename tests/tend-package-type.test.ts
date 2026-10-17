import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

const STEP = [
  'import { z } from "zod";',
  'import { defineStep } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "I wave",',
  '  description: "Waves",',
  "  args: z.object({}),",
  "  returns: z.object({}),",
  "  async run() {",
  "    return {};",
  "  },",
  "});",
  "",
].join("\n");

type Note = { code: string; file?: string; message: string; do: string };

async function tendNotes(rootDir: string): Promise<{ exitCode: number; notes: Note[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  const report = JSON.parse(stdout.text()) as { notes: Note[] };
  return { exitCode, notes: report.notes.filter((note) => note.code === "package-type-missing") };
}

describe("nuka tend: package-type-missing", () => {
  let rootDir: string;
  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'export default {};\n');
    await writeFile(path.join(rootDir, "features", "steps", "wave.ts"), STEP);
    await writeFile(path.join(rootDir, "features", "steps", "wave-again.mts"), STEP.replace("I wave", "I wave again"));
  });
  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names the package.json and counts the .ts files it governs when it has no type", async () => {
    await writeFile(path.join(rootDir, "package.json"), '{ "name": "typeless" }\n');

    const { exitCode, notes } = await tendNotes(rootDir);

    expect(notes).toEqual([
      {
        code: "package-type-missing",
        file: "package.json",
        message:
          'package.json has no "type" field, and it governs 2 .ts or .js files nukadoko loads, so Node parses each one twice and prints a MODULE_TYPELESS_PACKAGE_JSON warning on every load',
        do: 'Add "type": "module" to package.json, or rename those files to .mts if the project\'s own .js files are CommonJS.',
      },
    ]);
    expect(exitCode).toBe(0);
  });

  it("names the nested package.json that governs a step file, and not the root one that has a type", async () => {
    await writeFile(path.join(rootDir, "package.json"), '{ "type": "module" }\n');
    await writeFile(path.join(rootDir, "features", "package.json"), "{}\n");

    const { notes } = await tendNotes(rootDir);

    expect(notes).toEqual([
      {
        code: "package-type-missing",
        file: "features/package.json",
        message:
          'features/package.json has no "type" field, and it governs 1 .ts or .js file nukadoko loads, so Node parses it twice and prints a MODULE_TYPELESS_PACKAGE_JSON warning on every load',
        do: 'Add "type": "module" to features/package.json, or rename that file to .mts if the project\'s own .js files are CommonJS.',
      },
    ]);
  });

  it("says nothing when package.json has a type", async () => {
    await writeFile(path.join(rootDir, "package.json"), '{ "type": "module" }\n');

    expect((await tendNotes(rootDir)).notes).toEqual([]);
  });
});
