import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, withoutNoConfigLine } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: check-integration tests
// — compat participates in undefined-step/duplicate/ambiguous
// detection across kind, and a Then-position compat step gets a soft
// warning. A compat-origin defineParameterType still shares one registry
// with config-origin entries (collision reuses the existing
// `parameter-type-invalid` error), and is not a finding of its own.

describe("nuka check: compat integration", () => {
  it("reports kind-crossing duplicate-pattern and ambiguous-step errors, plus a then-compat-step warning", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; message: string }>;
      warnings: Array<{ code: string; message: string }>;
    };

    // Compat patterns participate in undefined-step judgment: "a compat-only
    // thing happens" is covered by compat-glue.ts's own Given, so it must
    // never surface as undefined.
    const undefinedIssues = report.errors.filter((issue) => issue.code === "undefined-step");
    expect(undefinedIssues.some((issue) => issue.message.includes("a compat-only thing happens"))).toBe(
      false,
    );

    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-pattern" }),
        expect.objectContaining({ code: "ambiguous-step" }),
      ]),
    );
    expect(report.errors.map((issue) => issue.code).sort()).toEqual(
      ["ambiguous-step", "duplicate-pattern"].sort(),
    );

    // compat-glue.ts registers a support-origin parameter type, and that is
    // no warning: then-compat-step remains, with scenario-without-then for
    // the scenario whose only Then is that compat step.
    expect(report.warnings.map((issue) => issue.code)).toEqual(["then-compat-step", "scenario-without-then"]);

    expect(exitCode).toBe(1);
  });

  it("then-compat-step's message says static check can't clear it and names the gap as static, not a run-time finding", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const thenCompat = report.warnings.find(
      (issue: { code: string }) => issue.code === "then-compat-step",
    );
    expect(thenCompat).toBeDefined();
    expect(thenCompat.message).toContain("Then position");
    expect(thenCompat.message).toContain("static coverage gap");
  });

  it("reuses the existing parameter-type-invalid error when a compat-origin type collides with a built-in", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-parameter-type-collision-project"),
      stdout,
      stderr,
    });

    expect(withoutNoConfigLine(stderr.text())).toBe("");
    const report = bySeverity(stdout.text());
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "parameter-type-invalid" })]),
    );
    expect(exitCode).toBe(1);
  });
  it("reports two compat types that prefer one regexp as parameter-type-invalid, naming the file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-preferential-regexp-project"),
      stdout,
      stderr,
    });

    expect(withoutNoConfigLine(stderr.text())).toBe("");
    const report = bySeverity(stdout.text());
    expect(report.errors.filter((issue: { code: string }) => issue.code === "parameter-type-invalid")).toEqual([
      {
        code: "parameter-type-invalid",
        message:
          'Custom parameter type "codeB" sets preferForRegexpMatch on /[A-Z]+/, which {codeA} already prefers: only one parameter type can be preferred for a regexp, so set preferForRegexpMatch on one of them',
        file: path.join("features", "steps", "code-glue.ts"),
        fix: "Rename the parameter type, or remove the second registration or the second preferForRegexpMatch.",
      },
    ]);
    expect(exitCode).toBe(1);
  });

  it("reports a compat type that prefers a built-in type's regexp as parameter-type-invalid, naming the file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-preferential-builtin-project"),
      stdout,
      stderr,
    });

    expect(withoutNoConfigLine(stderr.text())).toBe("");
    const report = bySeverity(stdout.text());
    expect(report.errors.filter((issue: { code: string }) => issue.code === "parameter-type-invalid")).toEqual([
      {
        code: "parameter-type-invalid",
        message:
          'Custom parameter type "count" sets preferForRegexpMatch on /-?\\d+/, which {int} already prefers: only one parameter type can be preferred for a regexp, so set preferForRegexpMatch on one of them',
        file: path.join("features", "steps", "count-glue.ts"),
        fix: "Rename the parameter type, or remove the second registration or the second preferForRegexpMatch.",
      },
    ]);
    expect(exitCode).toBe(1);
  });
});
