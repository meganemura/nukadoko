import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { shownTargetPath } from "../src/feature/feature-arg-read.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: a target that names nothing is printed relative to the
// project root when it lies inside, and absolute when it lies outside,
// never as a chain of `..`.

describe("shownTargetPath", () => {
  it("never shows a path that climbs out of the project, and keeps one inside as given", () =>
    hegel.test((tc) => {
      const segments = tc.draw(gs.arrays(gs.sampledFrom(["..", "a", "b.feature"]), { minSize: 1, maxSize: 6 }));
      const rootDir = path.resolve("/project/root");
      const relative = path.relative(rootDir, path.resolve(rootDir, ...segments));
      const shown = shownTargetPath(rootDir, relative);
      expect(shown.split(path.sep).includes("..")).toBe(false);
      expect(path.resolve(rootDir, shown)).toBe(path.resolve(rootDir, relative));
      if (!relative.startsWith("..")) expect(shown).toBe(relative);
    }));
});

describe("a target outside the project is named by its absolute path", () => {
  const outside = path.join(os.tmpdir(), "nukadoko-no-such-target.feature");
  it.each([
    [["run", outside], `refused\ttarget-not-found\t-\tFeature file not found: ${outside}\n`],
    [["check", outside], `refused\ttarget-not-found\t-\tnuka check: feature file not found: ${outside}\n`],
  ])("nuka %j", async (argv, firstLine) => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(argv, { rootDir: fixture("pure-step-project"), stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(2);
    expect(stderr.text().split("\n").filter((line) => !line.startsWith("warning")).slice(0, 1).join("\n") + "\n").toBe(firstLine);
  });
});
