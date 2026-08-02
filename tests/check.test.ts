import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

describe("nuka check", () => {
  it("exits 0 with zero errors and zero warnings for a clean project", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    expect(report).toEqual({ errors: [], warnings: [] });
    expect(exitCode).toBe(0);
  });

  it("prints a human-readable ok line when there is nothing to report", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("ok: no issues found");
  });

  it("exits 0 with warnings only: env-file-missing, environment-env-file-missing, secrets-public-key-unknown, then-mutates", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "env-file-missing" }),
        expect.objectContaining({ code: "environment-env-file-missing" }),
        expect.objectContaining({ code: "secrets-public-key-unknown" }),
        expect.objectContaining({ code: "then-mutates" }),
      ]),
    );
    expect(report.warnings).toHaveLength(4);
    expect(exitCode).toBe(0);
  });

  it("then-mutates is a warning (declaration/position tension), not an error: check still exits 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const thenMutates = report.warnings.find(
      (issue: { code: string }) => issue.code === "then-mutates",
    );
    expect(thenMutates).toBeDefined();
    expect(thenMutates.message).toContain("bound in Then position");
    expect(thenMutates.message).toContain("run time");
    expect(exitCode).toBe(0);
  });

  it("exits 1 reporting features-dir-missing as an error when featuresDir doesn't exist", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-features-dir-missing-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual([expect.objectContaining({ code: "features-dir-missing" })]);
    expect(exitCode).toBe(1);
  });

  it("exits 1 and reports every error category at least once", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    const codes = report.errors.map((issue: { code: string }) => issue.code).sort();

    for (const expectedCode of [
      "unnamed-capture",
      "invalid-capture-key",
      "unknown-parameter-type",
      "args-not-object",
      "unknown-capture-key",
      "capture-type-mismatch",
      "alias-key-mismatch",
      "duplicate-pattern",
      "ambiguous-step",
      "table-docstring-key-mismatch",
      "undefined-step",
      "feature-parse-error",
    ]) {
      expect(codes).toContain(expectedCode);
    }
    expect(exitCode).toBe(1);
  });

  it("every issue has a stable kebab-case code and a message", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    for (const issue of [...report.errors, ...report.warnings]) {
      expect(issue.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it("prints one human-readable line per issue when --json is omitted", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const lines = stdout.text().trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^error\t/);
    }
  });

  it("undefined-step hints at an escapable near-miss pattern (fineract-style bare parens)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-escape-hint-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const undefinedIssues = report.errors.filter(
      (issue: { code: string }) => issue.code === "undefined-step",
    );
    expect(undefinedIssues).toHaveLength(2);

    const hinted = undefinedIssues.find((issue: { message: string }) =>
      issue.message.includes('the amount (USD) is "100"'),
    );
    expect(hinted).toBeDefined();
    expect(hinted.message).toContain("hint:");
    expect(hinted.message).toContain('pattern "the amount (USD) is {amount:string}"');
    expect(hinted.message).toContain("escaped");

    const unrelated = undefinedIssues.find((issue: { message: string }) =>
      issue.message.includes("matches nothing at all"),
    );
    expect(unrelated).toBeDefined();
    expect(unrelated.message).not.toContain("hint:");

    expect(exitCode).toBe(1);
  });

  it("propagates a ConfigError as stderr + exit 1, no report on stdout", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });
});

describe("nuka check [feature]", () => {
  it("detects an undefined step in a feature outside featuresDir when given as an argument", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const undefinedIssues = report.errors.filter((issue: { code: string }) => issue.code === "undefined-step");
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0].message).toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("accepts an absolute path the same way", async () => {
    const stdout = createCaptureSink();
    const rootDir = fixture("check-feature-arg-project");
    const exitCode = await runCli(["check", path.join(rootDir, "acceptance/outside.feature"), "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const undefinedIssues = report.errors.filter((issue: { code: string }) => issue.code === "undefined-step");
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0].message).toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("does not mix in featuresDir's own feature errors when a feature argument is given", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const messages = [...report.errors, ...report.warnings].map((issue: { message: string }) => issue.message);
    expect(messages.join("\n")).not.toContain("this step is undefined inside featuresDir");
    expect(report.errors.every((issue: { file?: string }) => issue.file !== "features/inside.feature")).toBe(true);
  });

  it("still runs config and binding checks when a feature argument is given", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const codes = report.errors.map((issue: { code: string }) => issue.code);
    expect(codes).toContain("unknown-parameter-type");
  });

  it("no argument still checks every feature under featuresDir, unchanged", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const messages = [...report.errors].map((issue: { message: string }) => issue.message);
    expect(messages.join("\n")).toContain("this step is undefined inside featuresDir");
    expect(messages.join("\n")).not.toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("a nonexistent feature path prints to stderr and exits 1, with no report", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "acceptance/does-not-exist.feature"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("nuka check");
    expect(stderr.text()).toContain("acceptance/does-not-exist.feature");
  });
});
