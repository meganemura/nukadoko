import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { noStepFilesDo } from "../src/check/no-step-files-do.js";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s
// two new findings, both decidable from the walk alone (an extension check,
// a length check), never a guess about a file's contents.

describe("nuka check: step-file-unsupported-extension", () => {
  it("names a .cjs file discovery walked but never imported, as an error", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-cjs-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };

    const issue = report.errors.find((entry) => entry.code === "step-file-unsupported-extension");
    expect(issue).toBeDefined();
    expect(issue?.file).toBe(path.join("features", "steps", "legacy.cjs"));
    expect(issue?.message).toContain("legacy.cjs");

    // The real .ts step still discovers and binds normally -- the .cjs
    // finding does not take the rest of the project down with it.
    expect(report.errors.some((entry) => entry.code === "undefined-step")).toBe(false);

    expect(exitCode).toBe(1);
  });

  it("names a .cts file the same way, and skips a .d.cts declaration", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-cjs-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const issues = report.errors.filter((entry) => entry.code === "step-file-unsupported-extension");
    expect(issues.map((entry) => entry.file)).toEqual([
      path.join("features", "steps", "legacy.cjs"),
      path.join("features", "steps", "legacy.cts"),
    ]);
    expect(issues[1]?.message).toBe(
      `discovery found "${path.join("features", "steps", "legacy.cts")}", which is CommonJS (.cts extension); nukadoko is ESM-only and never imports it, so any step it defines never reaches the vocabulary`,
    );
  });

  it("does not fire when no .cjs file exists under featuresDir", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as { errors: Array<{ code: string }> };
    expect(report.errors.some((entry) => entry.code === "step-file-unsupported-extension")).toBe(
      false,
    );
    expect(exitCode).toBe(0);
  });
});

describe("nuka check: no-step-files-found", () => {
  it("names the directory it walked when nothing loadable was found there", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-no-step-files-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string; do?: string }>;
    };

    const issue = report.errors.find((entry) => entry.code === "no-step-files-found");
    expect(issue).toBeDefined();
    expect(issue?.file).toBe("features");
    expect(issue?.message).toContain("features");
    expect(issue?.do).toBe("Add a step file under featuresDir. nuka scaffold writes one.");

    expect(exitCode).toBe(1);
  });

  it("names the scaffold command for the checked feature files whose lines are all undefined", async () => {
    const rootDir = await copyFixtureToTempDir("check-no-step-files-project");
    try {
      await writeFile(path.join(rootDir, "features", "a.feature"), "Feature: a\n\n  Scenario: s\n    Given an empty directory\n");
      await writeFile(path.join(rootDir, "features", "b.feature"), "Feature: b\n\n  Scenario: t\n    Then it exits with 0\n");
      const doFor = async (args: string[]) => {
        const stdout = createCaptureSink();
        await runCli(["check", "--json", ...args], { rootDir, stdout, stderr: createCaptureSink() });
        const report = JSON.parse(stdout.text()) as { errors: Array<{ code: string; do?: string }> };
        return report.errors.find((entry) => entry.code === "no-step-files-found")?.do;
      };
      expect(await doFor([])).toBe(
        'Run nuka scaffold --feature for each of features/a.feature, features/b.feature. Step files outside "features" are never read: move any there instead.',
      );
      expect(await doFor(["features/b.feature"])).toBe(
        'Run nuka scaffold --feature features/b.feature. Step files outside "features" are never read: move any there instead.',
      );
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("does not fire for a project with real step files", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as { errors: Array<{ code: string }> };
    expect(report.errors.some((entry) => entry.code === "no-step-files-found")).toBe(false);
    expect(exitCode).toBe(0);
  });

  it("does not fire when featuresDir itself is missing -- features-dir-missing already names that", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-features-dir-missing-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as { errors: Array<{ code: string }> };
    // check.test.ts's own "features-dir-missing" test already pins this
    // fixture's error list to exactly one entry; this test only adds that
    // the second entry is not no-step-files-found reporting the same root
    // cause under a different code.
    expect(report.errors).toEqual([expect.objectContaining({ code: "features-dir-missing" })]);
    expect(exitCode).toBe(1);
  });
});

describe("noStepFilesDo", () => {
  it("names each distinct file once, and says nothing new when no line is undefined", () =>
    hegel.test((tc) => {
      const files = tc.draw(gs.arrays(gs.sampledFrom(["features/a.feature", "features/b.feature", "docs/c.md"]), { maxSize: 6 }));
      const text = noStepFilesDo(files, "features");
      const distinct = [...new Set(files)];
      if (distinct.length === 0) {
        expect(text).toBeUndefined();
        return;
      }
      for (const file of distinct) expect(text!.split(file).length).toBe(2);
      expect(text!.endsWith('Step files outside "features" are never read: move any there instead.')).toBe(true);
      expect(text!.startsWith(distinct.length === 1 ? `Run nuka scaffold --feature ${distinct[0]}.` : "Run nuka scaffold --feature for each of ")).toBe(true);
    }));
});
