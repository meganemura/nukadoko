import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readRunSources, runSourcesPath, writeRunSources } from "../src/record/run-sources.js";
import { runRelativeDir } from "../src/record/state-layout.js";

// Responsibility: sources.json round-trips through its writer and reader,
// and a file the reader cannot trust says which of missing, corrupt, or
// another version it is, which `nuka report` refuses with
// run-sources-missing or run-sources-invalid.

describe("run sources", () => {
  let rootDir: string;
  const runDir = (): string => path.join(rootDir, runRelativeDir(".nukadoko", "run-1"));

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-run-sources-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reads back what it wrote", () =>
    hegel.test((tc) => {
      const project = tc.draw(gs.optional(gs.text({ maxSize: 20 })));
      const features = tc.draw(gs.arrays(gs.tuples(gs.text({ minSize: 1, maxSize: 20 }), gs.text({ maxSize: 200 })), { maxSize: 4 }));
      const sources = { project: project ?? null, features: features.map(([p, source]) => ({ path: p, source })) };
      writeRunSources(rootDir, ".nukadoko", "run-1", sources);
      expect(readRunSources(runDir())).toEqual({ sources });
    }));

  it("writes a versioned document", () => {
    writeRunSources(rootDir, ".nukadoko", "run-1", { project: "shop", features: [{ path: "features/a.feature", source: "Feature: a\n" }] });
    expect(readRunSources(runDir())).toEqual({ sources: { project: "shop", features: [{ path: "features/a.feature", source: "Feature: a\n" }] } });
  });

  it.each([
    ["no file", null, "missing", "holds no sources.json"],
    ["not JSON", "{", "corrupt", "holds a sources.json that does not parse as JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"],
    ["another schema version", JSON.stringify({ schema_version: 99, project: null, features: [] }), "version", "holds a sources.json with schema_version 99, and this release reads 1"],
    [
      "a feature without source",
      JSON.stringify({ schema_version: 1, project: null, features: [{ path: "a.feature" }] }),
      "corrupt",
      "holds a sources.json without a string-or-null project and a features list of path and source strings",
    ],
    [
      "a project that is not a string",
      JSON.stringify({ schema_version: 1, project: 3, features: [] }),
      "corrupt",
      "holds a sources.json without a string-or-null project and a features list of path and source strings",
    ],
  ])("reads %s as %s", (_name, text, problem, message) => {
    if (text !== null) {
      writeRunSources(rootDir, ".nukadoko", "run-1", { project: null, features: [] });
      writeFileSync(runSourcesPath(runDir()), text);
    }
    expect(readRunSources(runDir())).toEqual({ problem, message });
  });
});
