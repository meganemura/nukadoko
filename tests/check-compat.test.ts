import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: m2a-compat-registry task spec's check-integration tests
// (item 6) — compat participates in undefined-step/duplicate/ambiguous
// detection across kind, and a Then-position compat step gets a soft
// warning. A compat-origin defineParameterType still shares one registry
// with config-origin entries (collision reuses the existing
// `parameter-type-invalid` error) — but is no longer listed as a `check`
// warning itself: `parameter-type-support-origin` moved to `nuka tend`
// (m8d-move-to-tend task spec; see tests/tend-moved-findings.test.ts, which
// reuses this same check-compat-project fixture to prove it now surfaces
// there instead).

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

    // parameter-type-support-origin no longer appears here (moved to
    // `nuka tend`) even though this fixture's compat-glue.ts still registers
    // a support-origin parameter type — only then-compat-step remains.
    expect(report.warnings.map((issue) => issue.code)).toEqual(["then-compat-step"]);

    expect(exitCode).toBe(1);
  });

  it("then-compat-step's message says static check can't clear it and names the gap as static, not a run-time finding", async () => {
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

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "parameter-type-invalid" })]),
    );
    expect(exitCode).toBe(1);
  });
});
