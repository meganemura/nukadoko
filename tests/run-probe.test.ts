import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --probe` through the CLI. A read-only Then that
// ignores its capture still passes with the capture changed and becomes a
// note; one that compares it fails the probe and stays quiet. Neither
// changes the exit code, and the probe leaves no step record.

const CHECKING_STEP = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import arrives from "./visitor-arrives.js";

export default defineStep({
  pattern: "the visitor {name:string} is recorded",
  description: "Compares the arrived visitor's name with the expected one",
  args: z.object({ name: z.string(), arrived: z.string() }),
  from: { arrived: [arrives, "name"] },
  returns: z.object({}),
  mutates: false,
  async run({}, args) {
    if (args.arrived !== args.name) throw new Error(\`expected \${args.name}, got \${args.arrived}\`);
    return {};
  },
});
`;

const CHECKING_FEATURE = `Feature: Recording a visitor

  Scenario: record a visitor
    Given a visitor named "Grace" arrives
    Then the visitor "Grace" is recorded
`;

interface Document {
  verdict: string;
  findings: { severity: string; code: string }[];
  scenarios: { feature: string; steps: { step_record_id: string | null }[]; probes?: unknown[] }[];
}

describe("nuka run --probe", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "visitor-recorded.ts"), CHECKING_STEP);
    await writeFile(path.join(rootDir, "features", "recorded.feature"), CHECKING_FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function run(args: string[]): Promise<{ exitCode: number; document: Document; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--json", ...args], { rootDir, stdout, stderr });
    return { exitCode, document: JSON.parse(stdout.text()) as Document, stderr: stderr.text() };
  }

  it("notes a Then that passes with its capture changed, and stays green", async () => {
    const { exitCode, document } = await run(["--probe", "features/greeting.feature"]);
    expect(exitCode).toBe(0);
    expect(document.verdict).toBe("passed");
    expect(document.scenarios[0]!.probes).toEqual([
      { line: 5, step: "visitor-greeted", key: "name", recorded: "Ada", changed: "Ada-probe", status: "passed" },
    ]);
    expect(document.findings).toEqual([
      {
        severity: "note",
        code: "then-passed-with-changed-capture",
        file: "features/greeting.feature",
        line: 5,
        step: "visitor-greeted",
        message: 'step "visitor-greeted" passed with name "Ada-probe" in place of "Ada"',
        fix: 'Make the step compare its result with the capture the message names; a step whose sentence also allows the changed value, such as "at least n", can stay as it is.',
        do: "nuka run features/greeting.feature:3 --probe",
      },
    ]);
  });

  it("records a probe the Then caught, with no note and no step record", async () => {
    const { exitCode, document } = await run(["--probe", "features/recorded.feature"]);
    expect(exitCode).toBe(0);
    expect(document.findings).toEqual([]);
    const [scenario] = document.scenarios;
    expect(scenario!.probes).toEqual([
      { line: 5, step: "visitor-recorded", key: "name", recorded: "Grace", changed: "Grace-probe", status: "failed" },
    ]);
    expect(scenario!.steps.map((step) => step.step_record_id === null)).toEqual([false, false]);
  });

  it("probes nothing without the flag", async () => {
    const { document } = await run(["features/greeting.feature"]);
    expect(document.findings).toEqual([]);
    expect(document.scenarios[0]!.probes).toBeUndefined();
  });

  it("probes in every worker under --concurrency", async () => {
    const { exitCode, document } = await run(["--probe", "--concurrency", "2", "features/greeting.feature", "features/recorded.feature"]);
    expect(exitCode).toBe(0);
    const probes = Object.fromEntries(document.scenarios.map((scenario) => [scenario.feature, scenario.probes]));
    expect(probes).toEqual({
      "features/greeting.feature": [
        { line: 5, step: "visitor-greeted", key: "name", recorded: "Ada", changed: "Ada-probe", status: "passed" },
      ],
      "features/recorded.feature": [
        { line: 5, step: "visitor-recorded", key: "name", recorded: "Grace", changed: "Grace-probe", status: "failed" },
      ],
    });
    expect(document.findings.map((finding) => finding.code)).toEqual(["then-passed-with-changed-capture"]);
  });

  it("prints the note after the count line in text", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--probe", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain(
      'note\tthen-passed-with-changed-capture\tfeatures/greeting.feature:5\tstep "visitor-greeted" passed with name "Ada-probe" in place of "Ada"\n',
    );
  });
});
