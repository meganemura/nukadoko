import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  removeTempDir,
  withoutNoConfigLine,
} from "./helpers/fixtures.js";

// Responsibility: a missing featuresDir and an empty one are different
// facts. `nuka steps` used to answer both with the exact same output
// (`{"steps": [], "import_failures": []}`, exit 0), the same silent
// failure `nuka check`'s `features-dir-missing` already refuses to make.
// `nuka describe` and `nuka do` used to answer the missing directory with
// "Unknown step", naming the step the caller asked for instead of the
// directory that is not there. The missing-directory cases below are one
// per command, so a regression that collapses any of them back into the
// empty-vocabulary answer fails at least one.

describe("nuka steps: featuresDir missing vs. featuresDir empty", () => {
  let rootDir: string;

  afterEach(async () => {
    if (rootDir) await removeTempDir(rootDir);
  });

  it("fails loudly when featuresDir does not exist on disk: stderr names the resolved path, stdout stays empty, non-JSON", async () => {
    rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps"], { rootDir, stdout, stderr });

    expect(exitCode).not.toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("featuresDir");
    expect(stderr.text()).toContain(path.join(rootDir, "features"));
  });

  it("fails loudly when featuresDir does not exist on disk: --json answers with a refusal, not an empty vocabulary", async () => {
    rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    // `{"steps": [], "import_failures": []}` here would read as success.
    // The refusal has no `steps` key at all, so no reader can mistake it.
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 1,
      error: `featuresDir "features" does not exist at ${path.join(rootDir, "features")}`,
      do: "nuka steps --help",
    });
    expect(withoutNoConfigLine(stderr.text())).toBe("");
  });

  it("still succeeds when featuresDir exists but has zero steps in it: exit 0, an empty list, not an error", async () => {
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features"), { recursive: true });
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ schema_version: 1, steps: [], import_failures: [] });
    expect(withoutNoConfigLine(stderr.text())).toBe("");
  });
});

describe("nuka describe and nuka do: featuresDir missing", () => {
  let rootDir: string;

  afterEach(async () => {
    if (rootDir) await removeTempDir(rootDir);
  });

  it("nuka describe names the missing featuresDir instead of the step, in its JSON refusal", async () => {
    rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["describe", "missing-step"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 1,
      error: `featuresDir "features" does not exist at ${path.join(rootDir, "features")}`,
      do: "nuka describe --help",
    });
    expect(withoutNoConfigLine(stderr.text())).toBe("");
  });

  it("nuka do names the missing featuresDir instead of the step: stderr names the resolved path, stdout stays empty", async () => {
    rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["do", "missing-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).not.toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("featuresDir");
    expect(stderr.text()).toContain(path.join(rootDir, "features"));
    expect(stderr.text()).not.toContain("Unknown step");
  });
});
