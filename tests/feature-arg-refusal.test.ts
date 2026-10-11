import { chmod } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka accept` and `nuka check` used to report every failed
// read of the feature argument as "feature file not found". A `:line`
// suffix, a directory, and any other read error (permission denied, a file
// used as a directory) are different mistakes, and the message has to name
// the one that happened. `nuka check` already names `:line` (see
// check-line-not-supported.test.ts). This file pins the cases that still
// collapsed, including `nuka accept`'s own `:line` refusal. A genuinely
// missing file stays "feature file not found" in the existing suites.

const DIRECTORY_HINT = "pass a .feature or .md file, or use nuka run for a directory";

async function invoke(
  command: "accept" | "check",
  featureArg: string,
  rootDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([command, featureArg], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka accept: a feature argument that is not a missing file", () => {
  it("refuses :line by name when the feature file exists", async () => {
    const rootDir = await copyFixtureToTempDir("accept-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("accept", "features/greeting.feature:2", rootDir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(":line is not supported");
      expect(stderr).toContain("only a whole-feature run can be accepted");
      expect(stderr).toContain("nuka accept features/greeting.feature");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("tells the reader to pass a file when the argument is a directory", async () => {
    const rootDir = await copyFixtureToTempDir("accept-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("accept", "features", rootDir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(DIRECTORY_HINT);
      expect(stderr).toContain("features");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("prints the read error when the feature file cannot be read", async () => {
    const rootDir = await copyFixtureToTempDir("accept-project");
    const feature = path.join(rootDir, "features", "greeting.feature");
    await chmod(feature, 0o000);
    try {
      const { exitCode, stdout, stderr } = await invoke("accept", "features/greeting.feature", rootDir);
      expect(exitCode).toBe(1);
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
    const rootDir = await copyFixtureToTempDir("accept-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("accept", "features/greeting.feature/extra", rootDir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("ENOTDIR");
      expect(stderr).toContain("not a directory");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka check: a feature argument that is not a missing file", () => {
  it("tells the reader to pass a file when the argument is a directory", async () => {
    const rootDir = await copyFixtureToTempDir("check-step-line-project");
    try {
      const { exitCode, stdout, stderr } = await invoke("check", "features", rootDir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(DIRECTORY_HINT);
      expect(stderr).toContain("features");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("prints the read error when the feature file cannot be read", async () => {
    const rootDir = await copyFixtureToTempDir("check-step-line-project");
    const feature = path.join(rootDir, "features", "probe.feature");
    await chmod(feature, 0o000);
    try {
      const { exitCode, stdout, stderr } = await invoke("check", "features/probe.feature", rootDir);
      expect(exitCode).toBe(1);
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
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("ENOTDIR");
      expect(stderr).toContain("not a directory");
      expect(stderr).not.toContain("feature file not found");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
