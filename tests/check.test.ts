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

  it("exits 0 with warnings only: env-file-missing, environment-env-file-missing, secrets-public-key-unknown", async () => {
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
      ]),
    );
    expect(report.warnings).toHaveLength(3);
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
      "then-mutates",
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
