import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  createExportsManifest,
  readExportsManifest,
  runExportsManifestPath,
} from "../src/record/run-exports.js";

// Responsibility: the exports manifest one `nuka run` leaves under
// `records/runs/<run_id>/` — that it is created with its directory, that
// what it lists is root-relative, and that reading it back gives a set in
// first-seen order however many times a path was appended.

describe("exports manifest", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-run-exports-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("lives under <stateDir>/records/runs/<run_id>/exports", () => {
    expect(runExportsManifestPath(rootDir, ".nukadoko", "run-1")).toBe(
      path.join(rootDir, ".nukadoko", "records", "runs", "run-1", "exports"),
    );
  });

  it("creates its directory on construction, before anything is noted", () => {
    const filePath = runExportsManifestPath(rootDir, ".nukadoko", "run-1");
    createExportsManifest(filePath, rootDir);
    expect(existsSync(path.dirname(filePath))).toBe(true);
    expect(readExportsManifest(filePath)).toEqual([]);
  });

  it("notes root-relative paths, one per line", () => {
    const filePath = runExportsManifestPath(rootDir, ".nukadoko", "run-1");
    const manifest = createExportsManifest(filePath, rootDir);
    manifest.note(path.join(rootDir, ".nukadoko", "export", "allure-results", "a-result.json"));
    expect(readFileSync(filePath, "utf8")).toBe(`${path.join(".nukadoko", "export", "allure-results", "a-result.json")}\n`);
  });

  it("reads back the distinct paths in first-seen order, whatever was appended how often", () =>
    hegel.test((tc) => {
      const names = tc.draw(gs.arrays(gs.fromRegex("[a-z]{1,3}\\.json"), { minSize: 0, maxSize: 12 }));
      const filePath = runExportsManifestPath(rootDir, ".nukadoko", `run-${tc.draw(gs.integers({ minValue: 0, maxValue: 1e6 }))}`);
      const manifest = createExportsManifest(filePath, rootDir);
      for (const name of names) {
        manifest.note(path.join(rootDir, "out", name));
      }
      const expected: string[] = [];
      for (const name of names) {
        const relative = path.join("out", name);
        if (!expected.includes(relative)) expected.push(relative);
      }
      expect(readExportsManifest(filePath)).toEqual(expected);
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }));
});
