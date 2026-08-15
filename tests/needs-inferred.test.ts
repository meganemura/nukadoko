import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka steps --json`/text end-to-end for `needs_inferred`
// — against tests/fixtures/needs-inferred-
// project, a project of exclusively pre-migration (`run(ctx, args)`) steps
// plus one migrated twin (a required ground-truth
// regression), and against the pre-existing tests/fixtures/fixture-bag-
// project for the "inference itself also fails" case (a destructured
// prop's own default value/rest property throws a different error shape,
// carrying no bare first-argument identifier to scan by at all). Read-only:
// `nuka steps` never executes a step, so both fixture projects are read
// directly rather than copied to a temp dir (same choice tests/steps-
// needs-json.test.ts already makes for the same reason).

async function stepsJson(rootDir: string): Promise<{ steps: StepSummary[]; exitCode: number }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  const report = JSON.parse(stdout.text()) as { steps: StepSummary[] };
  return { steps: report.steps, exitCode };
}

describe("nuka steps --json: needs_inferred for a pre-migration step", () => {
  it("stays needs: null + needs_error, gains needs_inferred, and never gets needs_browser", async () => {
    const { steps, exitCode } = await stepsJson(fixture("needs-inferred-project"));
    const step = steps.find((s) => s.name === "legacy-basic");
    expect(step?.needs).toBeNull();
    expect(step?.needs_error).toBeDefined();
    expect(step).not.toHaveProperty("needs_browser");
    expect(step?.needs_inferred).toEqual(["page"]);
    // A step whose own needs couldn't be read is still an incomplete
    // answer, guess or not (the same exit-1 rule, unchanged here).
    expect(exitCode).toBe(1);
  });

  it("filters out a member access that is not a known fixture name (ctx.someHelper())", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const step = steps.find((s) => s.name === "legacy-basic");
    expect(step?.needs_inferred).not.toContain("someHelper");
  });

  it("does not read a member access inside a string literal (the one measured false positive)", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const step = steps.find((s) => s.name === "legacy-string-literal");
    expect(step?.needs_inferred).toEqual([]);
  });

  it("reads an optional-chained member access (ctx?.page)", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const step = steps.find((s) => s.name === "legacy-optional-chaining");
    expect(step?.needs_inferred).toEqual(["page"]);
  });

  it("reads a mid-body destructuring alias (const { page, section } = ctx)", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const step = steps.find((s) => s.name === "legacy-destructure-const");
    expect(step?.needs_inferred).toEqual(["page", "section"]);
  });

  it("ground truth: a pre-migration step's needs_inferred equals its migrated twin's needs", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const legacy = steps.find((s) => s.name === "legacy-ground-truth");
    const migrated = steps.find((s) => s.name === "migrated-ground-truth");
    expect(migrated?.needs).toEqual(["env", "page"]);
    expect(legacy?.needs_inferred).toEqual(migrated?.needs);
  });

  it("a migrated step is entirely unaffected: needs as before, no needs_inferred at all", async () => {
    const { steps } = await stepsJson(fixture("needs-inferred-project"));
    const migrated = steps.find((s) => s.name === "migrated-ground-truth");
    expect(migrated?.needs).toEqual(["env", "page"]);
    expect(migrated?.needs_error).toBeUndefined();
    expect(migrated).not.toHaveProperty("needs_inferred");
  });
});

describe("nuka steps --json: needs_inferred stays absent when inference itself can't be attempted", () => {
  it("a default-value throw carries no bare identifier to scan by — needs_inferred is omitted, same as before", async () => {
    const { steps, exitCode } = await stepsJson(fixture("fixture-bag-project"));
    const step = steps.find((s) => s.name === "default-value-step");
    expect(step?.needs).toBeNull();
    expect(step?.needs_error).toContain("default value");
    expect(step).not.toHaveProperty("needs_inferred");
    expect(exitCode).toBe(1);
  });

  it("a rest-property throw carries no bare identifier to scan by — needs_inferred is omitted, same as before", async () => {
    const { steps } = await stepsJson(fixture("fixture-bag-project"));
    const step = steps.find((s) => s.name === "rest-step");
    expect(step?.needs).toBeNull();
    expect(step).not.toHaveProperty("needs_inferred");
  });
});

describe("nuka steps (text): needs (inferred) marker", () => {
  it("shows 'needs (inferred)' in place of 'needs unreadable' when a guess was possible", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("needs-inferred-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const text = stdout.text();
    const heading = text.split("\n").find((line) => line.startsWith("legacy-basic "));
    expect(heading).toBe("legacy-basic  typed  read-only  needs (inferred)");
    expect(exitCode).toBe(1);
  });

  it("still shows 'needs unreadable', unchanged, when no guess was possible", async () => {
    const stdout = createCaptureSink();
    await runCli(["steps"], {
      rootDir: fixture("fixture-bag-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const text = stdout.text();
    const heading = text.split("\n").find((line) => line.startsWith("default-value-step "));
    expect(heading).toBe("default-value-step  typed  read-only  needs unreadable");
  });

  it("never spells out the inferred list itself in text output (--json only, same rule as needs)", async () => {
    const stdout = createCaptureSink();
    await runCli(["steps"], {
      rootDir: fixture("needs-inferred-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const text = stdout.text();
    // The `needs_error` reason line legitimately quotes "{ page, section }"
    // as a generic example (the same static message text every un-
    // destructured step gets); what must not appear is the JSON field
    // itself, or the specific inferred list rendered as one.
    expect(text).not.toContain('needs_inferred"');
    expect(text).not.toMatch(/\benv,\s*page\b/);
  });
});
