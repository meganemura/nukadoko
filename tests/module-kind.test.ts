import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommonJsProject } from "../src/config/module-kind.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: isCommonJsProject's own truth table — the one fact `nuka
// init`'s config-file choice and `nuka check`'s step-file-import-failed
// message both defer to (src/config/module-kind.ts's own header).

describe("isCommonJsProject", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("is false when there is no package.json at all", () => {
    expect(isCommonJsProject(rootDir)).toBe(false);
  });

  it('is false when package.json has "type": "module"', async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    expect(isCommonJsProject(rootDir)).toBe(false);
  });

  it("is true when package.json has no type field at all", async () => {
    await writeFile(path.join(rootDir, "package.json"), JSON.stringify({ name: "x" }));
    expect(isCommonJsProject(rootDir)).toBe(true);
  });

  it('is true when package.json has "type": "commonjs" explicitly (what a fresh `npm init -y` writes)', async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "x", type: "commonjs" }),
    );
    expect(isCommonJsProject(rootDir)).toBe(true);
  });

  it("is false (never a guess) when package.json exists but is not valid JSON", async () => {
    await writeFile(path.join(rootDir, "package.json"), "{ this is not json");
    expect(isCommonJsProject(rootDir)).toBe(false);
  });
});
