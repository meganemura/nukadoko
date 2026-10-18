import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readRunSources, runSourcesPath, writeRunSources } from "../src/record/run-sources.js";
import { runRelativeDir } from "../src/record/state-layout.js";

// Responsibility: sources.json round-trips through its writer and reader,
// and a file the reader cannot trust reads as missing, which is what
// `nuka report` refuses with run-sources-missing.

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
      expect(readRunSources(runDir())).toEqual(sources);
    }));

  it("writes a versioned document", () => {
    writeRunSources(rootDir, ".nukadoko", "run-1", { project: "shop", features: [{ path: "features/a.feature", source: "Feature: a\n" }] });
    expect(readRunSources(runDir())).toEqual({ project: "shop", features: [{ path: "features/a.feature", source: "Feature: a\n" }] });
  });

  it.each([
    ["no file", null],
    ["not JSON", "{"],
    ["another schema version", JSON.stringify({ schema_version: 99, project: null, features: [] })],
    ["a feature without source", JSON.stringify({ schema_version: 1, project: null, features: [{ path: "a.feature" }] })],
    ["a project that is not a string", JSON.stringify({ schema_version: 1, project: 3, features: [] })],
  ])("reads %s as missing", (_name, text) => {
    if (text !== null) {
      writeRunSources(rootDir, ".nukadoko", "run-1", { project: null, features: [] });
      writeFileSync(runSourcesPath(runDir()), text);
    }
    expect(readRunSources(runDir())).toBeNull();
  });
});
