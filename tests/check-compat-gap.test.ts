import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: check-integration
// tests — a broken glue file becomes a `step-file-import-failed` report
// entry instead of taking the whole `nuka check` run down (decision 4), the
// `undefined-step` noise that failure would otherwise cause is suppressed
// and surfaced as its own warning (decision 6), an unsupported hook tag
// expression is reported for every violating hook (decision 5), and neither
// mechanism fires — or suppresses anything — on a project with neither gap.

describe("nuka check: import-failure gap detection", () => {
  it("reports step-file-import-failed, suppresses the resulting undefined-step, and says so", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
      warnings: Array<{ code: string; message: string }>;
    };

    const importFailure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(importFailure).toBeDefined();
    expect(importFailure?.file).toBe("features/steps/broken.ts");
    expect(importFailure?.message).toContain("require is not defined");

    expect(report.errors.filter((issue) => issue.code === "undefined-step")).toHaveLength(0);

    const suppressed = report.warnings.find(
      (issue) => issue.code === "undefined-step-check-suppressed",
    );
    expect(suppressed).toBeDefined();
    expect(suppressed?.message).toContain("1");

    expect(exitCode).toBe(1);
  });

  it("does not suppress undefined-step, and reports no import failure, when no glue file is broken", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
    };
    expect(report.errors.some((issue) => issue.code === "undefined-step")).toBe(true);
    expect(report.errors.some((issue) => issue.code === "step-file-import-failed")).toBe(false);
    expect(report.warnings.some((issue) => issue.code === "undefined-step-check-suppressed")).toBe(
      false,
    );

    expect(exitCode).toBe(1);
  });
});

describe("nuka check: hook tag expression gap detection", () => {
  it("reports unsupported-hook-tag-expression for every violating hook, not just the first", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-tag-expression-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };

    const tagIssues = report.errors.filter((issue) => issue.code === "unsupported-hook-tag-expression");
    expect(tagIssues).toHaveLength(2);
    expect(tagIssues.some((issue) => issue.message.includes("@a and @b"))).toBe(true);
    expect(tagIssues.some((issue) => issue.message.includes("@c or @d"))).toBe(true);
    for (const issue of tagIssues) {
      expect(issue.file).toBeUndefined();
    }

    expect(exitCode).toBe(1);
  });
});
