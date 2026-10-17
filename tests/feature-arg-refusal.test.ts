import { chmod } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka check` used to report every failed
// read of the feature argument as "feature file not found". A `:line`
// suffix and any other read error (permission denied, a file used as a
// directory) are different mistakes, and the message has to name the one
// that happened. A directory is not a mistake: check selects the files
// under it the way `nuka run` does (check-targets.test.ts). `nuka check` already names `:line` (see
// check-line-not-supported.test.ts). This file pins the cases that still
// collapsed. A genuinely
// missing file stays "feature file not found" in the existing suites.

async function invoke(
  command: "check",
  featureArg: string,
  rootDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([command, featureArg], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka check: a feature argument that is not a missing file", () => {
  it("prints the read error when the feature file cannot be read", async () => {
    const rootDir = await copyFixtureToTempDir("check-step-line-project");
    const feature = path.join(rootDir, "features", "probe.feature");
    await chmod(feature, 0o000);
    try {
      const { exitCode, stdout, stderr } = await invoke("check", "features/probe.feature", rootDir);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("EACCES");
      expect(stderr).toContain("permission denied");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await chmod(feature, 0o644);
      await removeTempDir(rootDir);
    }
  });

  it("prints the read error when a feature file is used as a directory", async () => {
    const rootDir = await copyFixtureToTempDir("check-step-line-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("check", "features/probe.feature/extra", rootDir);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("ENOTDIR");
      expect(stderr).toContain("not a directory");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("treats :line on a directory as :line, because the suffixed path is not the directory", async () => {
    const rootDir = await copyFixtureToTempDir("check-step-line-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("check", "features:2", rootDir);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(":line is not supported");
      expect(stderr).toContain("nuka check features");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
