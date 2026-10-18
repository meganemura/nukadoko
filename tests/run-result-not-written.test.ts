import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a run whose run.json or sources.json cannot be written. The run fails,
// the finding is inside the document `--json` prints, and the text output
// names no run.json location for a file that does not exist.

// Puts a non-empty directory where run.json goes, so the final rename
// fails the way a full disk or a read-only state directory would.
const BLOCKING_STEP = `import { mkdirSync, readdirSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the run file is blocked",
  description: "Occupies the path run.json is written to",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    const runs = new URL("../../.nukadoko/runs/", import.meta.url);
    for (const runId of readdirSync(runs)) mkdirSync(new URL(\`\${runId}/run.json/occupied/\`, runs), { recursive: true });
    return {};
  },
});
`;

const FEATURE = `Feature: A blocked run file

  Scenario: block it
    Given the run file is blocked
`;

describe("nuka run when run.json cannot be written", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "run-file-blocked.ts"), BLOCKING_STEP);
    await writeFile(path.join(rootDir, "features", "blocked.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails, and carries the finding in the --json document", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "features/blocked.feature"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toBe("");
    const document = JSON.parse(stdout.text()) as { verdict: string; counts: unknown; findings: { severity: string; code: string }[] };
    expect(document.verdict).toBe("failed");
    expect(document.findings.map((finding) => [finding.severity, finding.code])).toEqual([["failed", "run-result-not-written"]]);
  });

  it("says failed in the summary and in $GITHUB_STEP_SUMMARY, with the finding that failed it", async () => {
    const stepSummary = path.join(rootDir, "step-summary.md");
    const before = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    try {
      expect(await runCli(["run", "features/blocked.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(1);
    } finally {
      if (before === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = before;
    }
    const runsDir = path.join(rootDir, ".nukadoko", "runs");
    const [runId] = readdirSync(runsDir);
    const summary = readFileSync(path.join(runsDir, runId!, "summary.md"), "utf8");
    expect(summary.split("\n").slice(0, 2)).toEqual(["<!-- nukadoko:run -->", "# nukadoko run failed: 1 scenario, 1 passed"]);
    expect(summary).toContain("run-result-not-written");
    expect(readFileSync(stepSummary, "utf8")).toContain(summary);
  });

  it("names no run location in text, and leaves no temporary file", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/blocked.feature"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    const text = stderr.text();
    expect(text).toMatch(/^failed\trun-result-not-written\t-\trun\.json was not written: /m);
    expect(text).not.toMatch(/^run\s+\.nukadoko\/runs\//m);
    expect(text).toMatch(/^summary\s+\.nukadoko\/runs\/[^/]+\/summary\.md$/m);
    const runsDir = path.join(rootDir, ".nukadoko", "runs");
    const [runId] = readdirSync(runsDir);
    expect(readdirSync(path.join(runsDir, runId!)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(path.join(runsDir, runId!, "run.json", "occupied"))).toBe(true);
  });
});

// The same blocking step, aimed at sources.json: what nuka report parses a
// run's scenarios from.
const BLOCKING_SOURCES_STEP = BLOCKING_STEP.replace("the run file is blocked", "the sources file is blocked").replace("run.json/occupied/", "sources.json/occupied/");

const SOURCES_FEATURE = `Feature: A blocked sources file

  Scenario: block it
    Given the sources file is blocked
`;

describe("nuka run when sources.json cannot be written", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "sources-file-blocked.ts"), BLOCKING_SOURCES_STEP);
    await writeFile(path.join(rootDir, "features", "blocked.feature"), SOURCES_FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails, and carries the finding in the --json document and in run.json", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "features/blocked.feature"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toBe("");
    const document = JSON.parse(stdout.text()) as { verdict: string; findings: { severity: string; code: string }[] };
    expect(document.verdict).toBe("failed");
    expect(document.findings.map((finding) => [finding.severity, finding.code])).toEqual([["failed", "run-sources-not-written"]]);
    const runsDir = path.join(rootDir, ".nukadoko", "runs");
    const [runId] = readdirSync(runsDir);
    const written = JSON.parse(readFileSync(path.join(runsDir, runId!, "run.json"), "utf8")) as typeof document;
    expect(written.verdict).toBe("failed");
    expect(written.findings.map((finding) => finding.code)).toEqual(["run-sources-not-written"]);
  });
});
