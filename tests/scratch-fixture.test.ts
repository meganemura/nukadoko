import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { buildStepFixtures, createStepContext } from "../src/context/create-context.js";
import { InvalidScratchPrefixError } from "../src/context/errors.js";
import { createScratchCollector } from "../src/context/scratch.js";

// Responsibility: the builtin `scratch` fixture through the same handle
// every executor uses (`createStepContext`, `buildStepFixtures`,
// `beginStep`, `evidenceSnapshot`, `dispose`). The property is the reason
// the fixture exists: whatever a step does with it, and however the step
// ends, no directory it was handed survives `dispose()`.

function baseConfig(): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    retention: { runs: 20, adHocDays: 7 },
    stepTimeout: 1_200_000,
    browserType: "chromium",
    worldParameters: {},
  };
}

type Op =
  | { readonly kind: "dir"; readonly prefix: string | undefined }
  | { readonly kind: "copy"; readonly source: "seed" | "seed/hello.txt" }
  | { readonly kind: "boundary" };

const op: gs.Generator<Op> = gs.oneOf<Op>(
  gs.sampledFrom([undefined, "", "probe", "a.b"]).map((prefix): Op => ({ kind: "dir", prefix })),
  gs.sampledFrom(["seed", "seed/hello.txt"] as const).map((source): Op => ({ kind: "copy", source })),
  gs.just<Op>({ kind: "boundary" }),
);

describe("scratch: every directory is gone after dispose", () => {
  let rootDir: string;
  let evidenceDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-scratch-root-"));
    await mkdir(path.join(rootDir, "seed", "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "seed", "hello.txt"), "hello");
    await writeFile(path.join(rootDir, "seed", "nested", "deep.txt"), "deep");
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-scratch-evidence-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("removes every directory handed out, whatever the count, the calls, and the outcome", () =>
    hegel.testAsync(
      async (tc) => {
        const ops = tc.draw(gs.arrays(op, { minSize: 0, maxSize: 12 }));
        const fails = tc.draw(gs.booleans());

        const handle = createStepContext({ config: baseConfig(), evidenceDir, rootDir, env: {} });
        const { scratch } = await buildStepFixtures(handle.ctx, ["scratch"]);
        const handedOut: string[] = [];
        let sinceBoundary: string[] = [];
        try {
          for (const step of ops) {
            if (step.kind === "boundary") {
              await handle.beginStep(evidenceDir);
              sinceBoundary = [];
              continue;
            }
            const created = step.kind === "dir" ? scratch.dir(step.prefix) : await scratch.copy(step.source);
            expect(existsSync(created)).toBe(true);
            handedOut.push(created);
            sinceBoundary.push(created);
          }
          expect((await handle.evidenceSnapshot()).scratch).toEqual(sinceBoundary);
          if (fails) {
            throw new Error("the step failed");
          }
        } catch (error) {
          if (!fails) throw error;
        } finally {
          await handle.dispose();
        }

        expect(new Set(handedOut).size).toBe(handedOut.length);
        for (const created of handedOut) {
          expect(existsSync(created)).toBe(false);
        }
      },
      { testCases: 40 },
    ));
});

describe("scratch: what dir() and copy() hand back", () => {
  let tmpRoot: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "nukadoko-scratch-tmp-"));
    rootDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-scratch-root-"));
    await mkdir(path.join(rootDir, "seed", "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "seed", "hello.txt"), "hello");
    await writeFile(path.join(rootDir, "seed", "nested", "deep.txt"), "deep");
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates an empty directory named after the prefix, directly under the temporary root", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });
    const named = collector.scratch.dir("probe");
    const unnamed = collector.scratch.dir();

    expect(path.dirname(named)).toBe(tmpRoot);
    expect(path.basename(named)).toMatch(/^probe-/);
    expect(path.basename(unnamed)).toMatch(/^nukadoko-scratch-/);
    expect(await readdir(named)).toEqual([]);
  });

  it("refuses a prefix with a path separator and creates nothing", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });

    expect(() => collector.scratch.dir("a/b")).toThrow(InvalidScratchPrefixError);
    expect(() => collector.scratch.dir("a\\b")).toThrow(InvalidScratchPrefixError);
    expect(await readdir(tmpRoot)).toEqual([]);
    expect(collector.snapshot()).toEqual([]);
  });

  it("copies a directory's contents to the top of the new directory, resolved against the project root", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });
    const copied = await collector.scratch.copy("seed");

    expect((await readdir(copied)).sort()).toEqual(["hello.txt", "nested"]);
    expect(await readFile(path.join(copied, "nested", "deep.txt"), "utf8")).toBe("deep");
  });

  it("copies a file into the new directory under its own name", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });
    const copied = await collector.scratch.copy(path.join(rootDir, "seed", "hello.txt"));

    expect(await readdir(copied)).toEqual(["hello.txt"]);
  });

  it("throws for a missing source and leaves no directory behind", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });

    await expect(collector.scratch.copy("no-such-dir")).rejects.toThrow(/ENOENT/);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("does not fail when the step already removed a directory itself", async () => {
    const collector = createScratchCollector({ rootDir, tmpRoot });
    const created = collector.scratch.dir();
    await rm(created, { recursive: true });

    await expect(collector.removeAll()).resolves.toBeUndefined();
  });
});
