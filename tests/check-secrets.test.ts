import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  fixture,
  initGitRepo,
  removeTempDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s two secrets-redact-and-warning
// additions.
//
// Part A — secrets-redact-key-too-short: a pure config-coherence warning,
// checked against a static fixture (no git state involved). Its sibling,
// secrets-redact-key-unknown, moved to `nuka tend` —
// tests/tend-moved-findings.test.ts reuses this same
// check-secrets-redact-project fixture to prove it now surfaces there
// instead, and that `check` no longer reports it.
//
// Part B — tracked-secret-looking-key: only fires for a *tracked* envFile,
// so each of its tests needs a real git repository with a real commit —
// copyFixtureToTempDir + initGitRepo (tests/helpers/fixtures.ts), the same
// pairing tests/probe-git.test.ts and tests/run-provenance.test.ts already
// use for "this file is genuinely tracked" cases.

describe("nuka check: secrets.redact config-coherence warnings", () => {
  it("reports secrets-redact-key-too-short, no errors, and no longer reports secrets-redact-key-unknown", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-secrets-redact-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "secrets-redact-key-too-short",
        message: expect.stringContaining("SHORT_REDACT_KEY"),
      }),
    ]);
    expect(exitCode).toBe(0);
  });
});

describe("nuka check: tracked-secret-looking-key", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir !== undefined) {
      await removeTempDir(rootDir);
      rootDir = undefined;
    }
  });

  async function writeConfig(dir: string, redact: readonly string[]): Promise<void> {
    await writeFile(
      path.join(dir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        "export default defineConfig({",
        '  envFiles: [".env.app"],',
        `  secrets: { redact: ${JSON.stringify(redact)} },`,
        "});",
        "",
      ].join("\n"),
    );
  }

  it("warns when a tracked envFile defines a secret-looking key not in secrets.redact", async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeConfig(rootDir, []);
    await writeFile(path.join(rootDir, ".env.app"), "API_SECRET_KEY=plaintext-tracked-value\n");
    await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "tracked-secret-looking-key",
          file: ".env.app",
          message: expect.stringContaining("API_SECRET_KEY"),
        }),
      ]),
    );
    // The warning is advisory only — it must not turn into an error, or
    // change the exit code (docs/spec.md "CLI summary": exit code is
    // exactly "1 or more errors").
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("does not warn once the key is named in secrets.redact", async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeConfig(rootDir, ["API_SECRET_KEY"]);
    await writeFile(path.join(rootDir, ".env.app"), "API_SECRET_KEY=plaintext-tracked-value\n");
    await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    const report = JSON.parse(stdout.text());
    expect(
      report.warnings.some((issue: { code: string }) => issue.code === "tracked-secret-looking-key"),
    ).toBe(false);
  });

  it("does not warn when the same key is defined by an untracked file instead", async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeConfig(rootDir, []);
    // Commit everything *before* the env file exists, so the env file
    // itself is a real, uncommitted, untracked path in this nested repo —
    // classifyEnvFiles' own "secret source" case, already redacted through
    // the existing mechanism rather than this warning.
    await initGitRepo(rootDir);
    await writeFile(path.join(rootDir, ".env.app"), "API_SECRET_KEY=plaintext-untracked-value\n");

    const stdout = createCaptureSink();
    await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    const report = JSON.parse(stdout.text());
    expect(
      report.warnings.some((issue: { code: string }) => issue.code === "tracked-secret-looking-key"),
    ).toBe(false);
  });

  it('does not warn for names that merely contain "key" (MONKEY, KEYWORD)', async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeConfig(rootDir, []);
    await writeFile(
      path.join(rootDir, ".env.app"),
      "MONKEY=zoo-animal-value\nKEYWORD=search-term-value\n",
    );
    await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    expect(
      report.warnings.some((issue: { code: string }) => issue.code === "tracked-secret-looking-key"),
    ).toBe(false);
    expect(exitCode).toBe(0);
  });
});
