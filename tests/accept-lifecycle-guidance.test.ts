import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the sign-off-lifecycle guidance a successful `nuka accept`
// now writes to stderr (src/cli/accept.ts) — the one question ("does this
// describe the change, or the product's own path") and the two homes that
// answer it, never a recommendation for either. stdout is asserted
// unchanged elsewhere (tests/accept.test.ts's own record-shape assertions
// already depend on it being exactly the record's path); this file is only
// about the new stderr text.

describe("nuka accept: sign-off lifecycle guidance", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names where the record landed, both homes, the actual featuresDir value, and poses a question rather than a recommendation", async () => {
    await initGitRepo(rootDir);
    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], { rootDir, stdout, stderr });
    expect(acceptExit).toBe(0);

    // stdout: unchanged, still exactly the record's own relative path.
    const relativePath = stdout.text().trim();
    expect(relativePath).toMatch(/^features\/greeting\./);
    expect(stdout.text()).not.toMatch(/featuresDir|home/i);

    const guidance = stderr.text();
    // Names where the record landed.
    expect(guidance).toContain(relativePath);
    // Poses the question, states two consequences, recommends neither.
    expect(guidance).toContain("?");
    expect(guidance).not.toMatch(/\bshould\b|\bmust\b|\brecommended\b/i);
    // Names both homes: staying where it is, and the actual featuresDir
    // value (never a hardcoded default written over the config's own one).
    expect(guidance).toMatch(/where it is|left where/i);
    expect(guidance).toContain("features/");
    // Prose rule: no em-dash.
    expect(guidance).not.toMatch(/—/);
  });

  it("uses the config's own featuresDir value, not a hardcoded default", async () => {
    // accept-project's fixture defaults to featuresDir "features" — renamed
    // here to "acceptance-features" and the config edited to match, so a
    // message that still read "features/" (the old default, now wrong)
    // would prove the value was hardcoded rather than read from config.
    await rename(path.join(rootDir, "features"), path.join(rootDir, "acceptance-features"));
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        'export default defineConfig({ featuresDir: "acceptance-features" });',
        "",
      ].join("\n"),
    );
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "acceptance-features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "acceptance-features/greeting.feature"], { rootDir, stdout, stderr });
    expect(acceptExit).toBe(0);
    expect(stderr.text()).toContain("acceptance-features/");
  });
});
