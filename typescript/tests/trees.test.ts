import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { pathToFileURL } from "node:url";
import { baseTreeFiles, oldTreeFiles, overlayBaseTree, projectRelativeText, writeOldTree, type TreeInput, type TreeSource } from "../src/run/trees.js";

// Responsibility: what the base and the old tree of `nuka run --base`
// hold (src/run/trees.ts). The base tree is the ref's code with head's
// features directory and config; the old tree is head's code with the
// ref's features directory and config. The program file goes with the
// code, and the base tree takes head's only when the ref has none. The
// state directory is in neither. The plan is checked against those
// sentences, and the files on disk against the plan.

const directories = ["src", "src/lib", "features", "features/steps", "spec/features", "app", ".nukadoko/runs"];
const names = ["a.ts", "b.feature", "c.mjs"];
const file = gs.tuples(gs.sampledFrom(directories), gs.sampledFrom(names)).map(([dir, name]) => `${dir}/${name}`);
const fileSet = gs.arrays(gs.oneOf(file, gs.sampledFrom(["nukadoko.config.ts", "nukadoko.program.ts", "package.json"])), { maxSize: 10 }).map((files) => [...new Set(files)].sort());
const side = (files: readonly string[], featuresDir: string) => ({
  featuresDir,
  config: files.includes("nukadoko.config.ts") ? "nukadoko.config.ts" : null,
  program: files.includes("nukadoko.program.ts") ? "nukadoko.program.ts" : null,
});
const input = gs
  .tuples(fileSet, fileSet, gs.sampledFrom(["features", "spec/features"]), gs.sampledFrom(["features", "spec/features"]))
  .map(([headFiles, refFiles, headFeatures, refFeatures]): TreeInput => ({
    headFiles,
    refFiles,
    head: side(headFiles, headFeatures),
    ref: side(refFiles, refFeatures),
    stateDir: ".nukadoko",
  }));

const under = (name: string, dir: string): boolean => name === dir || name.startsWith(`${dir}/`);

describe("the trees of nuka run --base", () => {
  it("make the base tree of the ref's code, head's features directory and config, and the ref's program, or head's when the ref has none", () =>
    hegel.test((tc) => {
      const given = tc.draw(input);
      const expected = new Map<string, TreeSource>();
      for (const name of given.refFiles) {
        const mapping = under(name, given.ref.featuresDir) || name === given.ref.config;
        if (!mapping) expected.set(name, "ref");
      }
      for (const name of given.headFiles) if (under(name, given.head.featuresDir) || name === given.head.config) expected.set(name, "head");
      if (given.ref.program === null && given.head.program !== null) expected.set(given.head.program, "head");
      expect(baseTreeFiles(given)).toEqual(expected);
      if (given.ref.program !== null) expect(baseTreeFiles(given).get(given.ref.program)).toBe("ref");
    }));

  it("make the old tree of head's code and program, without the state directory, and the ref's features directory and config", () =>
    hegel.test((tc) => {
      const given = tc.draw(input);
      const expected = new Map<string, TreeSource>();
      for (const name of given.headFiles) {
        const mapping = under(name, given.head.featuresDir) || name === given.head.config;
        if (!mapping && !under(name, given.stateDir)) expected.set(name, "head");
      }
      for (const name of given.refFiles) if (under(name, given.ref.featuresDir) || name === given.ref.config) expected.set(name, "ref");
      expect(oldTreeFiles(given)).toEqual(expected);
      if (given.head.program !== null) expect(oldTreeFiles(given).get(given.head.program)).toBe("head");
      for (const name of oldTreeFiles(given).keys()) expect(under(name, given.stateDir)).toBe(false);
    }));

  function listed(dir: string, prefix = ""): string[] {
    return readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listed(dir, name) : [name];
    });
  }

  it("put on disk exactly the files the plan names, each from its side", () =>
    hegel.test(
      (tc) => {
        const given = tc.draw(input);
        const scratch = mkdtempSync(path.join(os.tmpdir(), "nukadoko-trees-"));
        try {
          const roots = { head: path.join(scratch, "head"), ref: path.join(scratch, "ref") };
          for (const [root, files, origin] of [
            [roots.head, given.headFiles, "head"],
            [roots.ref, given.refFiles, "ref"],
          ] as const) {
            mkdirSync(root, { recursive: true });
            for (const name of files) {
              mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
              writeFileSync(path.join(root, name), `${origin}:${name}`);
            }
          }
          // The old tree is written first, from the checkout of the ref as
          // it was checked out, which the base tree then overlays.
          const oldDir = path.join(scratch, "old");
          mkdirSync(oldDir);
          writeOldTree(given, roots, oldDir);
          overlayBaseTree(given, roots);
          for (const [dir, planned] of [
            [oldDir, oldTreeFiles(given)],
            [roots.ref, baseTreeFiles(given)],
          ] as const) {
            expect(listed(dir).sort()).toEqual([...planned.keys()].sort());
            for (const [name, source] of planned) expect(readFileSync(path.join(dir, name), "utf8")).toBe(`${source}:${name}`);
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
      { testCases: 40 },
    ));
});

describe("projectRelativeText", () => {
  const root = path.join(os.tmpdir(), "work", "app");
  const relative = gs.arrays(gs.sampledFrom([".nukadoko", "runs", "trees", "base", "features", "steps", "a.ts"]), { minSize: 1, maxSize: 4 }).map((parts) => parts.join("/"));

  it("writes every path under the project root, as a path or a file URL, from the root, and leaves a sibling directory alone", () =>
    hegel.test((tc) => {
      const inside = tc.draw(relative);
      const asUrl = tc.draw(gs.booleans());
      const written = asUrl ? `${pathToFileURL(root).href}/${inside}` : `${root}${path.sep}${inside.split("/").join(path.sep)}`;
      const sibling = `${root}2${path.sep}x.ts`;
      const shown = projectRelativeText(`Cannot find module '${written}' imported from ${sibling}`, root);
      expect(shown).toBe(`Cannot find module '${asUrl ? inside : inside.split("/").join(path.sep)}' imported from ${sibling}`);
    }));

  it("writes the root itself as a dot", () => {
    expect(projectRelativeText(`fatal: '${root}' is not a working tree. In ${root}.`, root)).toBe("fatal: '.' is not a working tree. In ..");
  });
});
