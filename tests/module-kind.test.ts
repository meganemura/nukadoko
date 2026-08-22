import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cjsTsMismatchExplanation, isCommonJsProject } from "../src/config/module-kind.js";
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

// Responsibility: cjsTsMismatchExplanation's own truth table — the one
// sentence both `nuka check`'s step-file-import-failed finding and
// `formatImportFailuresStderr` (`nuka steps`/`nuka describe`) append, and
// only when both conditions hold (src/config/module-kind.ts's own doc
// comment on this function).
describe("cjsTsMismatchExplanation", () => {
  it('returns the rename sentence when the project is CommonJS and the file is ".ts"', () => {
    const explanation = cjsTsMismatchExplanation(true, "features/steps/probe.ts");
    expect(explanation).toContain('"type": "module"');
    expect(explanation).toContain(".mts");
  });

  it("returns \"\" when the project is not CommonJS, even for a \".ts\" file", () => {
    expect(cjsTsMismatchExplanation(false, "features/steps/probe.ts")).toBe("");
  });

  it('returns "" when the project is CommonJS but the file is not ".ts" (e.g. ".mts")', () => {
    expect(cjsTsMismatchExplanation(true, "features/steps/probe.mts")).toBe("");
  });

  it('returns "" when neither condition holds', () => {
    expect(cjsTsMismatchExplanation(false, "features/steps/probe.mts")).toBe("");
  });
});
