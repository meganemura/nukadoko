import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, withoutNoConfigLine } from "./helpers/fixtures.js";

// Responsibility: `nuka steps <target>` (docs/spec.md "CLI summary"): the
// vocabulary of the scenarios a target selects, each step with the lines
// that bind it, the steps those call through `parts`, and a finding for a
// line that binds no single step. Uses tests/fixtures/parts-project, whose
// one patterned composite calls a part with no pattern of its own.

interface Listed {
  readonly name: string;
  readonly lines?: string[];
  readonly part_of?: string[];
}

async function steps(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["steps", ...args], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: withoutNoConfigLine(stderr.text()) };
}

describe("nuka steps <target>", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("parts-project");
    writeFileSync(
      path.join(rootDir, "features", "targets.feature"),
      [
        "Feature: targets",
        "",
        "  Background:",
        "    When a numeric part is called through a scenario with n 1",
        "",
        "  Scenario: one",
        "    When a numeric part is called through a scenario with n 2",
        "",
        "  Scenario: two",
        "    When no step reads this line",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("lists only the steps the target binds and their parts, each with its lines", async () => {
    const { exitCode, stdout } = await steps(rootDir, ["features/targets.feature", "--json"]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout) as { steps: Listed[]; findings: Array<{ code: string; file?: string; line?: number }> };
    expect(report.steps.map((s) => [s.name, s.lines, s.part_of])).toEqual([
      ["calls-numeric-part-via-run", ["features/targets.feature:4", "features/targets.feature:7"], undefined],
      ["takes-a-number", [], ["calls-numeric-part-via-run"]],
    ]);
    expect(report.findings.map((f) => [f.code, f.file, f.line])).toEqual([["undefined-step", "features/targets.feature", 10]]);
  });

  it("names a Background line once, though every scenario repeats it", async () => {
    const { stdout } = await steps(rootDir, ["features/targets.feature:6", "--json"]);
    const report = JSON.parse(stdout) as { steps: Listed[]; verdict: string };
    expect(report.verdict).toBe("passed");
    expect(report.steps.find((s) => s.name === "calls-numeric-part-via-run")?.lines).toEqual([
      "features/targets.feature:4",
      "features/targets.feature:7",
    ]);
  });

  it("prints the lines in text, and the unbound line on stderr", async () => {
    const { exitCode, stdout, stderr } = await steps(rootDir, ["features/targets.feature"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("  lines: features/targets.feature:4 features/targets.feature:7\n");
    expect(stdout).toContain("  part of: calls-numeric-part-via-run\n");
    expect(stderr).toContain('error\tundefined-step\tfeatures/targets.feature:10\tNo step definition matches "no step reads this line"');
  });

  it("refuses a line where no scenario starts", async () => {
    const { exitCode, stderr } = await steps(rootDir, ["features/targets.feature:5"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no-scenario-at-line");
  });

  it("lists the whole vocabulary with no lines field when no target is given", async () => {
    const { exitCode, stdout } = await steps(rootDir, ["--json"]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout) as { steps: Listed[] };
    expect(report.steps.length).toBeGreaterThan(2);
    expect(report.steps.every((s) => s.lines === undefined && s.part_of === undefined)).toBe(true);
  });
});
