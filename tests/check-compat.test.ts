import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: m2a-compat-registry task spec's check-integration tests
// (item 6) — compat participates in undefined-step/duplicate/ambiguous
// detection across kind, a Then-position compat step gets a soft warning,
// and a compat-origin defineParameterType is listed as a warning while
// sharing one registry with config-origin entries (collision reuses the
// existing `parameter-type-invalid` error).

describe("nuka check: compat integration", () => {
  it("reports kind-crossing duplicate-pattern and ambiguous-step errors, plus then-compat-step and parameter-type-support-origin warnings", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
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

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "then-compat-step" }),
        expect.objectContaining({ code: "parameter-type-support-origin" }),
      ]),
    );
    expect(report.warnings.map((issue) => issue.code).sort()).toEqual(
      ["parameter-type-support-origin", "then-compat-step"].sort(),
    );

    expect(exitCode).toBe(1);
  });

  it("then-compat-step's message says static check can't clear it and points at run-time observation", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const thenCompat = report.warnings.find(
      (issue: { code: string }) => issue.code === "then-compat-step",
    );
    expect(thenCompat).toBeDefined();
    expect(thenCompat.message).toContain("Then position");
    expect(thenCompat.message).toContain("run-time observation");
  });

  it("parameter-type-support-origin names the support-origin type and the config home it could move to", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const supportOrigin = report.warnings.find(
      (issue: { code: string }) => issue.code === "parameter-type-support-origin",
    );
    expect(supportOrigin).toBeDefined();
    expect(supportOrigin.message).toContain("shout-compat");
    expect(supportOrigin.message).toContain("config.parameterTypes");
  });

  it("reuses the existing parameter-type-invalid error when a compat-origin type collides with a built-in", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-compat-parameter-type-collision-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "parameter-type-invalid" })]),
    );
    expect(exitCode).toBe(1);
  });
});
