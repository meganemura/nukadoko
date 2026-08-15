import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

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
      errors: Array<{ code: string; message: string; file?: string }>;
    };

    const issue = report.errors.find((entry) => entry.code === "no-step-files-found");
    expect(issue).toBeDefined();
    expect(issue?.file).toBe("features");
    expect(issue?.message).toContain("features");

    expect(exitCode).toBe(1);
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
