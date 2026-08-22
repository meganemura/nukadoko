import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s "a feature nothing has ever accepted"
// finding, end to end. Every accepted feature here goes through a real
// `nuka run` + `nuka accept` (the same discipline tests/signoff-rot.test.ts
// already follows), never a hand-assembled record, so this proves the
// finding against a record the real writer produced, not one shaped by
// hand to match src/tend/record-parse.ts's own idea of "ok".
//
// tests/fixtures/tend-never-signed-project has two features under
// featuresDir and two more under an additionalFeatureDirs entry, one of
// each pair accepted by this file's own beforeEach and one left alone,
// so both "is it reported" and "is the signed one silent" are checked
// against the same report, in both scanned locations.

interface Report {
  errors: { code: string; file?: string }[];
  notes: { code: string; file?: string; message: string }[];
}

async function runTend(rootDir: string): Promise<{ report: Report; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as Report, exitCode };
}

describe("nuka tend: a feature nothing has ever accepted", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("tend-never-signed-project");
    await initGitRepo(rootDir);

    for (const featurePath of ["features/accepted.feature", "extra/accepted-extra.feature"]) {
      const runExit = await runCli(["run", featurePath], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const acceptExit = await runCli(["accept", featurePath], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(acceptExit).toBe(0);
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports the two never-accepted features, and only those two, as notes", async () => {
    const { report, exitCode } = await runTend(rootDir);

    // Never an error: an unaccepted feature is the ordinary state of one
    // still being drafted, so it must never fail the run on its own.
    expect(report.errors.filter((e) => e.code === "feature-never-signed")).toEqual([]);
    expect(exitCode).toBe(0);

    const neverSigned = report.notes
      .filter((n) => n.code === "feature-never-signed")
      .map((n) => n.file)
      .sort();
    expect(neverSigned).toEqual(["extra/never-signed-extra.feature", "features/never-signed.feature"]);
  });

  it("stays silent for the accepted feature inside featuresDir", async () => {
    const { report } = await runTend(rootDir);

    const files = report.notes.filter((n) => n.code === "feature-never-signed").map((n) => n.file);
    expect(files).not.toContain("features/accepted.feature");
  });

  it("stays silent for the accepted feature under additionalFeatureDirs", async () => {
    const { report } = await runTend(rootDir);

    const files = report.notes.filter((n) => n.code === "feature-never-signed").map((n) => n.file);
    expect(files).not.toContain("extra/accepted-extra.feature");
  });

  it("names the feature and the next command to run in the message", async () => {
    const { report } = await runTend(rootDir);

    const note = report.notes.find(
      (n) => n.code === "feature-never-signed" && n.file === "features/never-signed.feature",
    );
    expect(note).toBeDefined();
    expect(note!.message).toContain("features/never-signed.feature");
    expect(note!.message).toContain("nuka accept features/never-signed.feature");
  });
});
