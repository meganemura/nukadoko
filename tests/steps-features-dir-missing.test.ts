import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka
// steps` used to answer "no featuresDir on disk" and "featuresDir exists
// but has zero steps" with the exact same output (`{"steps": [],
// "import_failures": []}`, exit 0), the same silent failure `nuka check`'s
// `features-dir-missing` already refuses to make. These two tests are the
// spec's own required pair: one per condition, so a regression that
// collapses them back together fails at least one.

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

  it("fails loudly when featuresDir does not exist on disk: same condition, --json stays silent on stdout too", async () => {
    rootDir = await createEmptyTempDir();
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).not.toBe(0);
    // The bug this task fixes: `--json` used to print `{"steps": [],
    // "import_failures": []}` here, an empty-but-shaped answer that reads as
    // success. Failing must not gain a JSON error shape either — that would
    // just be a different lie in the same spot.
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("featuresDir");
    expect(stderr.text()).toContain(path.join(rootDir, "features"));
  });

  it("still succeeds when featuresDir exists but has zero steps in it: exit 0, an empty list, not an error", async () => {
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features"), { recursive: true });
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ steps: [], import_failures: [] });
    expect(stderr.text()).toBe("");
  });
});
