import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

const ESM_PACKAGE = JSON.stringify({ name: "p", private: true, type: "module" });

let rootDir: string | undefined;
let bareDir: string | undefined;

afterEach(async () => {
  if (rootDir !== undefined) await removeTempDir(rootDir);
  if (bareDir !== undefined) await rm(bareDir, { recursive: true, force: true });
  rootDir = undefined;
  bareDir = undefined;
});

async function project(files: Record<string, string>): Promise<string> {
  rootDir = await createEmptyTempDir();
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(rootDir, name), body);
  return rootDir;
}

async function refusalHint(argv: string[], dir: string): Promise<{ exitCode: number; doLine: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir: dir, stdout, stderr });
  const lines = stderr.text().trimEnd().split("\n");
  return { exitCode, doLine: lines[lines.length - 1]! };
}

describe("a config that does not load names its own fix", () => {
  it("a config with no default export", async () => {
    const dir = await project({ "package.json": ESM_PACKAGE, "nukadoko.config.ts": "export const x = 1;\n" });
    expect(await refusalHint(["run"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Export the config as the default export of nukadoko.config.ts: export default defineConfig({ ... }).",
    });
  });

  it("a config whose default export is a Promise", async () => {
    const dir = await project({ "package.json": ESM_PACKAGE, "nukadoko.config.ts": "export default Promise.resolve({});\n" });
    expect(await refusalHint(["check"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Export the config object itself as the default export of nukadoko.config.ts, not a Promise of it.",
    });
  });

  it("a config the schema refuses", async () => {
    const dir = await project({ "package.json": ESM_PACKAGE, "nukadoko.config.mts": "export default { featuresDir: 3 };\n" });
    expect(await refusalHint(["steps"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Correct the fields the message names in nukadoko.config.mts.",
    });
  });

  it("a config that does not parse", async () => {
    const dir = await project({ "package.json": ESM_PACKAGE, "nukadoko.config.ts": "export default {;\n" });
    expect(await refusalHint(["check"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Correct the error the message names in nukadoko.config.ts.",
    });
  });

  it("a config that imports a package the project has not installed", async () => {
    const dir = await project({
      "package.json": ESM_PACKAGE,
      "nukadoko.config.ts": 'import x from "not-installed-pkg";\nexport default { x };\n',
    });
    expect(await refusalHint(["check"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Install not-installed-pkg in the project, or correct the import of it in nukadoko.config.ts.",
    });
  });

  it("both config files", async () => {
    const dir = await project({
      "package.json": ESM_PACKAGE,
      "nukadoko.config.ts": "export default {};\n",
      "nukadoko.config.mts": "export default {};\n",
    });
    expect(await refusalHint(["steps"], dir)).toEqual({
      exitCode: 2,
      doLine: "  fix: Delete nukadoko.config.ts or nukadoko.config.mts, and keep the one that holds the project's config.",
    });
  });

  it("a project where nukadoko itself is not installed: check and init's self-check name the install line", async () => {
    bareDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-no-package-"));
    await writeFile(path.join(bareDir, "package.json"), ESM_PACKAGE);

    expect(await refusalHint(["init"], bareDir)).toEqual({ exitCode: 1, doLine: "  do: npm install -D -E nukadoko" });
    expect(await refusalHint(["check"], bareDir)).toEqual({ exitCode: 2, doLine: "  do: npm install -D -E nukadoko" });
  });
});
