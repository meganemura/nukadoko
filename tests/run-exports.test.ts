import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  createExportsManifest,
  readExportsManifest,
  readOwnedExports,
  runExportsManifestPath,
} from "../src/record/run-exports.js";

// Responsibility: the exports manifest one `nuka run` leaves under
// `runs/<run_id>/` — that it is created with its directory, that
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

  it("lives under <stateDir>/runs/<run_id>/exports", () => {
    expect(runExportsManifestPath(rootDir, ".nukadoko", "run-1")).toBe(
      path.join(rootDir, ".nukadoko", "runs", "run-1", "exports"),
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

describe("readOwnedExports", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-owned-exports-"));
    mkdirSync(path.join(rootDir, ".nukadoko", "export", "sub"), { recursive: true });
    mkdirSync(path.join(rootDir, ".nukadoko", "runs", "run-1"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    // Inside export/ by spelling, the project root once followed.
    symlinkSync(rootDir, path.join(rootDir, ".nukadoko", "export", "evil"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const segment = gs.sampledFrom(["sub", "evil", "..", "src", "a.json", ".nukadoko", "export"]);

  it("accepts a line only when its real parent directory is inside export/'s real path", () =>
    hegel.test(
      (tc) => {
        const segments = tc.draw(gs.arrays(segment, { minSize: 1, maxSize: 5 }));
        const prefix = tc.draw(gs.sampledFrom(["", path.join(".nukadoko", "export"), "/"]));
        const line = path.join(prefix, ...segments);
        writeFileSync(runExportsManifestPath(rootDir, ".nukadoko", "run-1"), `${line}\n`);
        const owned = readOwnedExports(rootDir, ".nukadoko", "run-1");
        const exportReal = realpathSync(path.join(rootDir, ".nukadoko", "export"));
        const absolute = path.resolve(rootDir, line);
        let parentReal: string | null;
        try {
          parentReal = realpathSync(path.dirname(absolute));
        } catch {
          parentReal = null;
        }
        // A line whose parent does not exist names nothing a removal could
        // reach; only one that does is decided by where it really is.
        if (parentReal === null) return;
        const inside = parentReal === exportReal || parentReal.startsWith(`${exportReal}${path.sep}`);
        expect(owned.files.map((file) => file.line)).toEqual(inside ? [line] : []);
      },
      { testCases: 200 },
    ));

  it("owns nothing through a manifest that is a symlink out of the run directory", () => {
    writeFileSync(path.join(rootDir, "forged"), `${path.join(".nukadoko", "export", "sub", "a.json")}\n`);
    symlinkSync(path.join(rootDir, "forged"), runExportsManifestPath(rootDir, ".nukadoko", "run-1"));
    expect(readOwnedExports(rootDir, ".nukadoko", "run-1")).toEqual({ manifestPath: null, files: [] });
  });

  it("owns nothing through a run directory that is a symlink under runs/", () => {
    const elsewhere = path.join(rootDir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "exports"), `${path.join(".nukadoko", "export", "sub", "a.json")}\n`);
    symlinkSync(elsewhere, path.join(rootDir, ".nukadoko", "runs", "run-2"));
    expect(readOwnedExports(rootDir, ".nukadoko", "run-2")).toEqual({ manifestPath: null, files: [] });
  });
});
