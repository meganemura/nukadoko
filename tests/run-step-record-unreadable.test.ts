import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step record that cannot be read back when nuka run
// builds the scenario's run.json entry. The step is marked, a warning names
// the record, and the summary lists that warning instead of leaving it out.

// Overwrites every step record the run has written so far, which is the
// earlier step's: its own is written after it returns.
const DAMAGING_STEP = `import { readdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the earlier step records are damaged",
  description: "Writes text that is not JSON over the step records written so far",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    const runs = new URL("../../.nukadoko/runs/", import.meta.url);
    for (const runId of readdirSync(runs)) {
      const steps = new URL(\`\${runId}/steps/\`, runs);
      for (const id of readdirSync(steps)) {
        try {
          writeFileSync(new URL(\`\${id}/record.json\`, steps), "not json");
        } catch {
          // This step's own directory has no record yet.
        }
      }
    }
    return {};
  },
});
`;

const FEATURE = `Feature: A damaged step record

  Scenario: damage it
    Given a visitor named "Ada" arrives
    When the earlier step records are damaged
`;

describe("nuka run with a step record it cannot read back", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "records-damaged.ts"), DAMAGING_STEP);
    await writeFile(path.join(rootDir, "features", "damaged.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("marks the step, warns, and lists the warning in the summary", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "features/damaged.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    const document = JSON.parse(stdout.text()) as {
      run_id: string;
      scenarios: { steps: { record_unreadable?: true; mutates?: unknown }[] }[];
      findings: { severity: string; code: string; message: string }[];
    };
    const [first, second] = document.scenarios[0]!.steps;
    expect([first!.record_unreadable, first!.mutates]).toEqual([true, undefined]);
    expect([second!.record_unreadable, second!.mutates]).toEqual([undefined, true]);
    expect(document.findings.map((finding) => [finding.severity, finding.code])).toEqual([["warning", "step-record-unreadable"]]);
    expect(document.findings[0]!.message).toMatch(
      /^\.nukadoko\/runs\/run-[^/]+\/steps\/[^/]+\/record\.json of features\/damaged\.feature:3 could not be read, so run\.json has no declaration or measurement for that step$/,
    );
    const runsDir = path.join(rootDir, ".nukadoko", "runs");
    const summary = readFileSync(path.join(runsDir, readdirSync(runsDir)[0]!, "summary.md"), "utf8");
    expect(summary).toContain("- warning `step-record-unreadable` ");
  });
});
