import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractStepDeclarations } from "../../src/extraction/step-extraction.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "fixtures");
// Reused directly rather than duplicated: proves extraction against a real,
// shipped typed step file, not just a fixture written to match this
// extractor's own expectations.
const addTodoPath = path.resolve(here, "..", "..", "..", "examples", "todo", "features", "steps", "add-todo.ts");

async function extractFixture(fileName: string) {
  const filePath = path.join(fixturesDir, fileName);
  const sourceText = await readFile(filePath, "utf8");
  return { filePath, result: await extractStepDeclarations(filePath, sourceText) };
}

describe("extractStepDeclarations: typed steps", () => {
  it("extracts a single-pattern default-exported defineStep call (examples/todo/features/steps/add-todo.ts)", async () => {
    const sourceText = await readFile(addTodoPath, "utf8");
    const result = await extractStepDeclarations(addTodoPath, sourceText);

    expect(result.unresolved).toEqual([]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      declarationFile: addTodoPath,
      kind: "typed",
      pattern: "a todo titled {title:string} is added",
    });
  });

  it("extracts every entry of a patterns array, all sharing the declaring call's own position", async () => {
    const { filePath, result } = await extractFixture("typed-patterns-array.ts");

    expect(result.unresolved).toEqual([]);
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns.map((p) => p.pattern)).toEqual(["a {x:int}", "an {x:int}"]);
    for (const pattern of result.patterns) {
      expect(pattern.kind).toBe("typed");
      expect(pattern.declarationFile).toBe(filePath);
    }
    expect(result.patterns[0]?.declarationPosition).toEqual(result.patterns[1]?.declarationPosition);
  });

  it("extracts nothing, and reports nothing unresolved, for a CLI-only step (no pattern, no patterns)", async () => {
    const { result } = await extractFixture("typed-cli-only.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports an unresolved declaration when pattern is a variable reference", async () => {
    const { filePath, result } = await extractFixture("typed-computed-pattern-variable.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ declarationFile: filePath });
    expect(result.unresolved[0]?.reason).toMatch(/cannot be resolved statically/);
  });

  it("reports an unresolved declaration when pattern is a template literal with an expression", async () => {
    const { filePath, result } = await extractFixture("typed-computed-pattern-template.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ declarationFile: filePath });
    expect(result.unresolved[0]?.reason).toMatch(/cannot be resolved statically/);
  });

  it("reports an unresolved declaration when defineStep's argument is not a static object literal", async () => {
    const { filePath, result } = await extractFixture("typed-non-object-argument.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ declarationFile: filePath });
    expect(result.unresolved[0]?.reason).toMatch(/not a single static object literal/);
  });

  it("extracts nothing when defineStep is imported from a module other than \"nukadoko\"", async () => {
    const { result } = await extractFixture("typed-wrong-module.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("extracts nothing when defineStep is imported under an alias (known v1 limitation)", async () => {
    const { result } = await extractFixture("typed-aliased-import.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("extractStepDeclarations: compat steps", () => {
  it("extracts a string pattern and a regexp literal, both imported from nukadoko/compat", async () => {
    const { filePath, result } = await extractFixture("compat-steps.ts");

    expect(result.unresolved).toEqual([]);
    expect(result.patterns).toHaveLength(4);
    for (const pattern of result.patterns) {
      expect(pattern.kind).toBe("compat");
      expect(pattern.declarationFile).toBe(filePath);
    }

    const stringPattern = result.patterns.find((p) => p.pattern === "a {int} widgets");
    expect(stringPattern).toBeDefined();

    const regexPattern = result.patterns.find((p) => p.pattern instanceof RegExp);
    expect(regexPattern?.pattern).toBeInstanceOf(RegExp);
    expect((regexPattern?.pattern as RegExp).source).toBe("^a (\\d+) widgets$");

    expect(result.patterns.some((p) => p.pattern === "the widgets are counted")).toBe(true);
    expect(result.patterns.some((p) => p.pattern === "there are {int} widgets left")).toBe(true);
  });

  it("extracts nothing when Given is imported from a module other than \"nukadoko/compat\"", async () => {
    const { result } = await extractFixture("compat-wrong-module.ts");

    expect(result.patterns).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});
