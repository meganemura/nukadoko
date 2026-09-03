import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { TEND_CODES } from "../src/tend/types.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka tend --fail-on <code>`: a chosen note turns the exit
// code red for that invocation, the finding itself stays a note, a code
// tend never emits is refused up front, and the list the flag is checked
// against is the list of codes the tend sources actually emit.

describe("TEND_CODES", () => {
  it("equals every code literal under src/tend/", () => {
    const dir = path.join(repoRoot, "src", "tend");
    const literals = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      for (const match of readFileSync(path.join(dir, name), "utf8").matchAll(/code: "([a-z0-9-]+)"/g)) {
        literals.add(match[1]!);
      }
    }
    expect([...TEND_CODES].sort()).toEqual([...literals].sort());
  });
});

describe("nuka tend --fail-on", () => {
  let rootDir: string;

  beforeEach(async () => {
    // accept-project: three features, none ever accepted, so
    // feature-never-signed fires three times and nothing else here is red.
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("exits 1 when a finding with the code is reported, says so on stderr, and keeps the finding a note", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "feature-never-signed"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toMatch(/^fail-on: feature-never-signed reported 3 findings$/m);
    expect(stdout.text()).toMatch(/^note\tfeature-never-signed\t/m);
    expect(stdout.text()).not.toMatch(/^error\tfeature-never-signed/m);
  });

  it("exits 0 when the code is valid but nothing reported it", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "repeated-scenario-prefix"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).not.toContain("fail-on:");
  });

  it("refuses a code tend never reports, naming the codes it does", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "feature-never-signd"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain('--fail-on: "feature-never-signd" is not a code nuka tend reports.');
    expect(stderr.text()).toContain("feature-never-signed");
  });

  it("takes a comma-separated list and a repeated flag alike", async () => {
    const commaErr = createCaptureSink();
    expect(
      await runCli(["tend", "--fail-on", "step-rationale-missing,feature-never-signed"], { rootDir, stdout: createCaptureSink(), stderr: commaErr }),
    ).toBe(1);
    expect(commaErr.text()).toContain("fail-on: step-rationale-missing reported");
    expect(commaErr.text()).toContain("fail-on: feature-never-signed reported");

    const repeatedErr = createCaptureSink();
    expect(
      await runCli(["tend", "--fail-on", "step-rationale-missing", "--fail-on", "feature-never-signed"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: repeatedErr,
      }),
    ).toBe(1);
    expect(repeatedErr.text()).toContain("fail-on: feature-never-signed reported");
  });

  it("keeps --json output parseable while the exit code turns red", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json", "--fail-on", "feature-never-signed"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout.text());
    expect(report.notes.filter((issue: { code: string }) => issue.code === "feature-never-signed")).toHaveLength(3);
  });
});
