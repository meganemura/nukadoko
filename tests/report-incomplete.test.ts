import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a report built from a run directory that lost part of
// itself says so in its exit code, and every format goes through the same
// tail: a Markdown file under the state directory is noted in the run's
// exports manifest like the other two, a step record that cannot be read
// is not shown as passed, and one missing attachment costs only
// that attachment.

describe("nuka report on a run with missing parts", () => {
  let rootDir: string;
  let runId: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    runId = latestRunJson(rootDir).run_id as string;
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  const runDir = (): string => path.join(rootDir, ".nukadoko", "runs", runId);
  const manifest = (): string[] => readFileSync(path.join(runDir(), "exports"), "utf8").split("\n").filter((line) => line.length > 0);
  const resultsDir = (): string => path.join(rootDir, ".nukadoko", "export", "allure-results");
  const results = (): { status: string; statusDetails?: { message?: string }; steps: { name: string; status: string; statusDetails?: { message?: string }; attachments: { name: string }[] }[] }[] =>
    readdirSync(resultsDir())
      .filter((name) => name.endsWith("-result.json"))
      .map((name) => JSON.parse(readFileSync(path.join(resultsDir(), name), "utf8")));

  // The first step of features/passing.feature, whose record the tests edit.
  function firstStep(): { id: string; record: string } {
    const step = (latestRunJson(rootDir).scenarios as { steps: { step_record_id: string; text: string }[] }[])[0]!.steps[0]!;
    return { id: step.step_record_id, record: path.join(runDir(), "steps", step.step_record_id, "record.json") };
  }

  it("notes a Markdown file written under the state directory in the run's exports manifest", async () => {
    const out = path.join(".nukadoko", "export", "summary.md");
    expect(await cli(["report", "--format", "markdown", "--out", out])).toEqual({ exitCode: 0, stdout: "", stderr: "markdown  .nukadoko/export/summary.md\n" });
    expect(manifest()).toEqual([out]);
    expect((await cli(["report", "--format", "markdown", "--out", out])).exitCode).toBe(0);
    expect(manifest()).toEqual([out, out]);
  });

  it("exits 1 with a failed report-incomplete finding, and shows the step and its result broken, when a step record is gone", async () => {
    const { id, record } = firstStep();
    rmSync(record);
    const allure = await cli(["report", "--format", "allure"]);
    expect(allure).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        `failed\treport-incomplete\t-\tsteps/${id}/record.json of ${(latestRunJson(rootDir).scenarios as { scenario_record_id: string }[])[0]!.scenario_record_id} could not be read\n` +
        "  fix: Correct what the message names, such as a step record removed from the run directory, and run nuka report again.\n" +
        "allure    .nukadoko/export/allure-results/  1\n",
    });
    const [result] = results();
    const message = `step record ${id} could not be read; run.json records this step as passed`;
    expect(result!.status).toBe("broken");
    expect(result!.statusDetails?.message).toBe(message);
    expect(result!.steps.map((step) => [step.status, step.statusDetails?.message])).toEqual([
      ["broken", message],
      ["passed", undefined],
    ]);
  });

  it("gives the --json envelope a failed verdict when a step record is gone", async () => {
    rmSync(firstStep().record);
    const result = await cli(["report", "--format", "allure", "--json"]);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as { verdict: string; findings: { severity: string; code: string }[] };
    expect(envelope.verdict).toBe("failed");
    expect(envelope.findings.map((finding) => [finding.severity, finding.code])).toEqual([["failed", "report-incomplete"]]);
  });

  it("shows a step whose record is gone UNKNOWN in the messages stream, and exits 1", async () => {
    const { id, record } = firstStep();
    rmSync(record);
    const result = await cli(["report", "--format", "messages"]);
    expect(result.exitCode).toBe(1);
    const finished = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { testStepFinished?: { testStepResult: { status: string; message?: string } } })
      .flatMap((envelope) => (envelope.testStepFinished !== undefined ? [envelope.testStepFinished.testStepResult] : []));
    expect(finished.map((stepResult) => [stepResult.status, stepResult.message])).toEqual([
      ["UNKNOWN", `step record ${id} could not be read; run.json records this step as passed`],
      ["PASSED", undefined],
    ]);
  });

  it("skips only an attachment that is gone, keeps the rest of the result, and exits 1", async () => {
    const { record } = firstStep();
    const stepRecord = JSON.parse(readFileSync(record, "utf8")) as { declared?: unknown; evidence: { dir: string } };
    writeFileSync(path.join(path.dirname(record), "kept.txt"), "kept");
    stepRecord.declared = { attachments: ["gone.txt", "kept.txt"], logs: [] };
    writeFileSync(record, JSON.stringify(stepRecord));
    const result = await cli(["report", "--format", "allure"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^failed\treport-incomplete\t-\tallure: could not attach .*gone\.txt: /m);
    expect(result.stderr).toMatch(/^allure {4}\.nukadoko\/export\/allure-results\/ {2}1$/m);
    const [written] = results();
    expect(written!.status).toBe("passed");
    expect(written!.steps[0]!.attachments.map((attachment) => attachment.name)).toContain("declared: kept.txt");
    expect(written!.steps[0]!.attachments.map((attachment) => attachment.name)).not.toContain("declared: gone.txt");
  });
});
