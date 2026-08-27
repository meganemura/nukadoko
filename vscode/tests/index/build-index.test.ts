import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildStepIndex, type FileSource } from "../../src/index/build-index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "fixtures");

// An in-memory-shaped fake: listFiles just returns whatever the test wants
// considered, readFile reads the real fixture off disk (fs.readFile, never
// import()) -- the same split extension.ts's real FileSource makes between
// vscode.workspace.findFiles and workspace.fs.readFile.
function fakeFileSource(filePaths: readonly string[]): FileSource {
  return {
    async listFiles() {
      return filePaths;
    },
    async readFile(filePath) {
      return readFile(filePath, "utf8");
    },
  };
}

describe("buildStepIndex", () => {
  it("aggregates patterns and unresolved declarations across every listed file", async () => {
    const compatPath = path.join(fixturesDir, "compat-steps.ts");
    const unresolvedPath = path.join(fixturesDir, "typed-computed-pattern-variable.ts");
    const source = fakeFileSource([compatPath, unresolvedPath]);

    const result = await buildStepIndex(source);

    expect(result.patterns).toHaveLength(4);
    expect(result.patterns.every((p) => p.kind === "compat" && p.declarationFile === compatPath)).toBe(true);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.declarationFile).toBe(unresolvedPath);
  });

  it("returns an empty index when the source lists no files", async () => {
    const result = await buildStepIndex(fakeFileSource([]));

    expect(result).toEqual({ patterns: [], unresolved: [] });
  });

  describe("zero execution", () => {
    // Mixes in the same kind of fixture the extraction-layer phase used to
    // prove this property one level down (tests/extraction/zero-execution.
    // test.ts): tests/fixtures/side-effecting-step.ts writes a marker file
    // the moment it is *evaluated*. buildStepIndex must reach it only
    // through FileSource.readFile (text), never by importing it.
    const fixturePath = path.join(fixturesDir, "side-effecting-step.ts");
    const markerPath = path.join(fixturesDir, "zero-execution-marker.txt");

    afterEach(() => {
      if (existsSync(markerPath)) {
        rmSync(markerPath);
      }
    });

    it("never runs a listed file's top-level side effect while building the index", async () => {
      expect(existsSync(markerPath)).toBe(false);

      const source = fakeFileSource([fixturePath, path.join(fixturesDir, "compat-steps.ts")]);
      const result = await buildStepIndex(source);

      // Extraction must still succeed on both files -- this proves the
      // marker's absence is because execution never happened, not because
      // reading or parsing silently failed on this fixture.
      expect(result.unresolved).toEqual([]);
      expect(result.patterns).toHaveLength(5);
      expect(result.patterns.some((p) => p.pattern === "a todo titled {title:string} is added")).toBe(true);

      expect(existsSync(markerPath)).toBe(false);
    });
  });
});
