import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: end-to-end coverage for a `from` entry whose runtime
// value is neither a `[Step, string]` tuple nor a list of them (an `as any`
// cast at the declaration, docs/spec.md "Chaining steps" never sanctions
// one) — `nuka steps`/`nuka describe`/`nuka check` against
// tests/fixtures/from-malformed-entry-project, which carries both shapes
// that used to reach a bare, unhelpful `TypeError` before a caller ever got
// a chance to name which key or step was wrong: a bare string
// (bad-string.ts) and a `Step` object passed directly instead of wrapped in
// a tuple (bad-object.ts). tests/check-structural-from.test.ts covers
// `from`'s other structural findings (an unregistered upstream, a missing
// returns key); this file is the one for an entry that fails to even
// normalize into candidates at all.

async function stepsJson(rootDir: string): Promise<{ steps: StepSummary[]; exitCode: number }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  const report = JSON.parse(stdout.text()) as { steps: StepSummary[] };
  return { steps: report.steps, exitCode };
}

interface TypedContract {
  readonly name: string;
  readonly from?: Record<string, string>;
  readonly from_errors?: ReadonlyArray<{ readonly key: string; readonly message: string }>;
}

async function describeJson(
  rootDir: string,
  name: string,
): Promise<{ contract: TypedContract; exitCode: number }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["describe", name], { rootDir, stdout, stderr: createCaptureSink() });
  return { contract: JSON.parse(stdout.text()) as TypedContract, exitCode };
}

interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(
  rootDir: string,
): Promise<{ exitCode: number; report: { errors: CheckIssue[]; warnings: unknown[] } }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return { exitCode, report: JSON.parse(stdout.text()) as { errors: CheckIssue[]; warnings: unknown[] } };
}

const PROJECT = fixture("from-malformed-entry-project");

describe("nuka steps --json: a malformed from entry", () => {
  it("does not crash the whole vocabulary — every step, broken or not, still shows up — but exits 1 for the from_errors", async () => {
    const { steps, exitCode } = await stepsJson(PROJECT);
    const names = steps.map((s) => s.name).sort();
    expect(names).toEqual(["archive-cart", "bad-object", "bad-string", "open-cart"]);
    expect(exitCode).toBe(1);
  });

  it("names the key and describes the value for a bare-string entry, in from_errors", async () => {
    const { steps } = await stepsJson(PROJECT);
    const step = steps.find((s) => s.name === "bad-string");
    expect(step?.from).toBeUndefined();
    expect(step?.from_errors).toEqual([{ key: "id", message: expect.stringContaining('from.id is not usable') }]);
    expect(step?.from_errors?.[0]?.message).toContain("string");
  });

  it("names the key and describes the value for a Step-object entry, in from_errors", async () => {
    const { steps } = await stepsJson(PROJECT);
    const step = steps.find((s) => s.name === "bad-object");
    expect(step?.from).toBeUndefined();
    expect(step?.from_errors).toEqual([{ key: "id", message: expect.stringContaining('from.id is not usable') }]);
    expect(step?.from_errors?.[0]?.message).toContain("Step");
  });

  it("still renders a genuinely correct from chain normally, next to the two broken steps", async () => {
    const { steps } = await stepsJson(PROJECT);
    const step = steps.find((s) => s.name === "archive-cart");
    expect(step?.from).toEqual({ cartId: { step: "open-cart", key: "id" } });
    expect(step?.from_errors).toBeUndefined();
  });
});

describe("nuka steps (text): a malformed from entry", () => {
  it("marks the broken step with 'from unreadable', prints the key-named reason, and exits 1 without crashing", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], { rootDir: PROJECT, stdout, stderr: createCaptureSink() });
    const text = stdout.text();
    expect(exitCode).toBe(1);

    const heading = text.split("\n").find((line) => line.startsWith("bad-string "));
    expect(heading).toBe("bad-string  typed  read-only  from unreadable");
    expect(text).toContain('from.id is not usable');

    // The healthy chain must still be there, unmarked.
    const healthyHeading = text.split("\n").find((line) => line.startsWith("archive-cart "));
    expect(healthyHeading).toBe("archive-cart  typed  mutates");
  });
});

describe("nuka describe: a malformed from entry", () => {
  it("bare string: reports from_errors instead of a fabricated candidate, exits 1, and does not silently lie", async () => {
    const { contract, exitCode } = await describeJson(PROJECT, "bad-string");
    expect(exitCode).toBe(1);
    expect(contract.from).toBeUndefined();
    expect(contract.from_errors).toEqual([{ key: "id", message: expect.stringContaining("from.id is not usable") }]);
    // The bug this guards against: normalizing a string as a one-element
    // candidate list used to destructure its own first two characters as
    // `[upstream, upstreamKey]`, rendering as "(unregistered step).<char>"
    // regardless of the string's actual content.
    expect(JSON.stringify(contract)).not.toContain("unregistered step");
  });

  it("Step object: reports from_errors instead of crashing, and exits 1", async () => {
    const { contract, exitCode } = await describeJson(PROJECT, "bad-object");
    expect(exitCode).toBe(1);
    expect(contract.from).toBeUndefined();
    expect(contract.from_errors).toEqual([{ key: "id", message: expect.stringContaining("from.id is not usable") }]);
  });

  it("a step with a genuinely correct from chain still exits 0 — the exit code is per step, not per project", async () => {
    const { contract, exitCode } = await describeJson(PROJECT, "archive-cart");
    expect(exitCode).toBe(0);
    expect(contract.from_errors).toBeUndefined();
  });
});

describe("nuka check: a malformed from entry", () => {
  it("reports both the bare-string and the Step-object shape as from-structural-violation, and exits 1", async () => {
    const { report, exitCode } = await checkReport(PROJECT);
    const byStep = new Map(
      report.errors.filter((issue) => issue.code === "from-structural-violation").map((issue) => [issue.step, issue]),
    );
    expect(byStep.get("bad-string")?.message).toContain("from.id is not usable");
    expect(byStep.get("bad-string")?.file).toBe("features/steps/bad-string.ts");
    expect(byStep.get("bad-object")?.message).toContain("from.id is not usable");
    expect(byStep.get("bad-object")?.file).toBe("features/steps/bad-object.ts");
    expect(exitCode).toBe(1);
  });

  it("says nothing about the genuinely correct from chain", async () => {
    const { report } = await checkReport(PROJECT);
    const issues = report.errors.filter(
      (issue) => issue.code === "from-structural-violation" && issue.step === "archive-cart",
    );
    expect(issues).toHaveLength(0);
  });
});
