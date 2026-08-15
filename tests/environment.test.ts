import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka do --env`'s wiring exercised end to end against
// tests/fixtures/environments-project —
// baseURL/envFiles layering, unknown-environment setup failure,
// `policy: "read-only"` refusal, and the `version` probe (success/throw).
// Session-scoping-by-environment tests live in their own file
// (session-environments.test.ts); pure resolution-logic unit tests live in
// resolve-environment.test.ts and probe-version.test.ts.

describe("nuka do --env: baseURL/envFiles layering", () => {
  it("uses the top-level baseURL/envFiles when --env is omitted", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "get-context", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.environment).toBe("default");
      expect(stepRecord.result).toEqual({
        baseURL: "http://top.example",
        key: "base",
        shared: "fromtop",
      });
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("overrides baseURL and appends envFiles (later file wins) for a named environment", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "staging"],
        { rootDir, stdout, stderr: createCaptureSink() },
      );

      expect(exitCode).toBe(0);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.environment).toBe("staging");
      expect(stepRecord.result).toEqual({
        baseURL: "http://staging.example",
        // .env.staging (the environment's own envFile) is merged *after*
        // the top-level .env.base, so its KEY value wins...
        key: "staging",
        // ...but SHARED, which only .env.base defines, still survives —
        // proving envFiles append rather than replace.
        shared: "fromtop",
      });
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("falls back to the top-level baseURL for an environment with no overrides", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "no-overrides"],
        { rootDir, stdout, stderr: createCaptureSink() },
      );

      expect(exitCode).toBe(0);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.environment).toBe("no-overrides");
      expect(stepRecord.result).toEqual({
        baseURL: "http://top.example",
        key: "base",
        shared: "fromtop",
      });
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka do --env: unknown environment", () => {
  it("fails setup (exit 1, no step record directory) for an explicit unknown --env name", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "no-such-env"],
        { rootDir, stdout: createCaptureSink(), stderr },
      );

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("no-such-env");
      expect(existsSync(`${rootDir}/.nukadoko`)).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka do --env: policy: read-only", () => {
  it("refuses a mutating step with exit 1 and no step record, naming the step, env, and policy", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "mutate", "--args", "{}", "--env", "readonly"],
        { rootDir, stdout: createCaptureSink(), stderr },
      );

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("mutate");
      expect(stderr.text()).toContain("readonly");
      expect(stderr.text()).toContain("read-only");
      expect(existsSync(`${rootDir}/.nukadoko`)).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("still runs a mutates: false step against a read-only environment", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "readonly"],
        { rootDir, stdout, stderr: createCaptureSink() },
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text()).environment).toBe("readonly");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka do --env: version probe", () => {
  it("records target_version on the step record when the probe succeeds", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "probe-ok"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      expect(JSON.parse(stdout.text()).target_version).toBe("1.2.3");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("omits target_version and warns on stderr, but still runs the step, when the probe throws", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "get-context", "--args", "{}", "--env", "probe-throws"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.target_version).toBeUndefined();
      expect(stepRecord.status).toBe("ok");
      expect(stderr.text()).toContain("probe boom");
      expect(stderr.text()).toContain("probe-throws");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("omits target_version with no warning when the environment configures no probe", async () => {
    const rootDir = await copyFixtureToTempDir("environments-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "get-context", "--args", "{}"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      expect(JSON.parse(stdout.text()).target_version).toBeUndefined();
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
