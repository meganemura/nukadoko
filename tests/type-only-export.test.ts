import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { TYPE_ONLY_EXPORTS, typeOnlyImportSentence } from "../src/config/type-only-export.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

const ENTRY_DECLARATIONS: Readonly<Record<string, string>> = {
  nukadoko: "dist/index.d.ts",
  "nukadoko/compat": "dist/compat/index.d.ts",
  "nukadoko/matching": "dist/matching/index.d.ts",
  "nukadoko/mcp": "dist/mcp/index.d.ts",
};

/** The names an entry's declaration file exports as types only: every name
 * in an `export type { ... }` list, and every `type X` inside an
 * `export { ... }` list. tsc writes an index file as these lists alone. */
function typeOnlyNames(declarations: string): string[] {
  const code = declarations.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const names: string[] = [];
  for (const [, typeList, members] of code.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    for (const member of members!.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
      if (typeList === undefined && !member.startsWith("type ")) continue;
      names.push(member.replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim());
    }
  }
  return names.sort();
}

describe("TYPE_ONLY_EXPORTS", () => {
  it("lists exactly the type-only exports of each built entry point", async () => {
    for (const [specifier, file] of Object.entries(ENTRY_DECLARATIONS)) {
      const declarations = await readFile(path.join(repoRoot, file), "utf8");
      expect([...(TYPE_ONLY_EXPORTS[specifier] ?? [])].sort()).toEqual(typeOnlyNames(declarations));
    }
    expect(Object.keys(TYPE_ONLY_EXPORTS).sort()).toEqual(Object.keys(ENTRY_DECLARATIONS).sort());
  });
});

describe("typeOnlyImportSentence", () => {
  const nodeMessage = (specifier: string, name: string) =>
    `The requested module '${specifier}' does not provide an export named '${name}'`;

  it("names import type for every type-only export of a nukadoko entry point", () =>
    hegel.test((tc) => {
      const specifier = tc.draw(gs.sampledFrom(Object.keys(TYPE_ONLY_EXPORTS)));
      const name = tc.draw(gs.sampledFrom([...TYPE_ONLY_EXPORTS[specifier]!]));
      expect(typeOnlyImportSentence(nodeMessage(specifier, name))).toBe(
        `; ${name} is a type, which ${specifier} exports for TypeScript only, and Node erases an imported name only when the import marks it as a type. ` +
          `Write import type { ${name} } from "${specifier}", or mark the one name inline as { type ${name} }`,
      );
    }));

  it("appends nothing for a name no entry point exports as a type", () =>
    hegel.test((tc) => {
      const specifier = tc.draw(gs.sampledFrom([...Object.keys(TYPE_ONLY_EXPORTS), "@cucumber/cucumber", "./world.ts"]));
      const name = tc.draw(gs.fromRegex("[A-Za-z][A-Za-z0-9]{0,12}"));
      tc.assume(!(TYPE_ONLY_EXPORTS[specifier] ?? []).includes(name));
      expect(typeOnlyImportSentence(nodeMessage(specifier, name))).toBe("");
    }));
});

describe("nuka check: a compat type imported without type", () => {
  it("reports step-file-import-failed with the import type sentence", async () => {
    await ensureNukadokoShim();
    const dir = await createEmptyTempDir();
    try {
      await mkdir(path.join(dir, "features", "steps"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
      await writeFile(
        path.join(dir, "features", "steps", "world.ts"),
        [
          'import { Given, IWorldOptions } from "nukadoko/compat";',
          "export function options(value: IWorldOptions): IWorldOptions {",
          "  return value;",
          "}",
          'Given("a world", function () {});',
          "",
        ].join("\n"),
      );
      const stdout = createCaptureSink();
      const exitCode = await runCli(["check", "--json"], { rootDir: dir, stdout, stderr: createCaptureSink() });
      const report = bySeverity(stdout.text()) as { errors: Array<{ code: string; file?: string; message: string }> };
      const failures = report.errors.filter((issue) => issue.code === "step-file-import-failed");
      expect(failures.map((issue) => issue.file)).toEqual(["features/steps/world.ts"]);
      expect(failures[0]!.message).toContain(
        "The requested module 'nukadoko/compat' does not provide an export named 'IWorldOptions'",
      );
      expect(failures[0]!.message).toContain(
        '; IWorldOptions is a type, which nukadoko/compat exports for TypeScript only, and Node erases an imported name only when the import marks it as a type. Write import type { IWorldOptions } from "nukadoko/compat", or mark the one name inline as { type IWorldOptions }',
      );
      expect(exitCode).toBe(1);
    } finally {
      await removeTempDir(dir);
    }
  });
});
