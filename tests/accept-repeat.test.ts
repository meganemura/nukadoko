import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what a `--repeat` run looks like to the commands that
// read one run. `nuka accept` embeds one execution per scenario and says
// how many times each ran; `nuka tend` does not read the repetition as a
// shared opening between "n scenarios" that are the same one.

describe("nuka accept and nuka tend after nuka run --repeat", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    await initGitRepo(rootDir);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("embeds each scenario once, the last execution, and states the count in Condition", async () => {
    expect(
      await runCli(["run", "features/greeting.feature", "--repeat", "3"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
    ).toBe(0);
    const stderr = createCaptureSink();
    expect(await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr }), stderr.text()).toBe(0);

    const [name] = readdirSync(path.join(rootDir, "features")).filter((entry) => entry.endsWith(".md"));
    const record = readFileSync(path.join(rootDir, "features", name!), "utf8");
    expect(record.match(/^    line: 3$/gm)).toHaveLength(1);
    expect(record.match(/^### greet a visitor \(line 3\)$/gm)).toHaveLength(1);
    expect(record).toContain("- repeat: each scenario ran 3 times in this run (nuka run --repeat), every execution green; the last one is embedded below");

    const tendOut = createCaptureSink();
    expect(await runCli(["tend"], { rootDir, stdout: tendOut, stderr: createCaptureSink() })).toBe(0);
    expect(tendOut.text()).not.toContain("repeated-scenario-prefix");
  });

  it("does not write the repeat line for an ordinary run", async () => {
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(0);
    expect(await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(0);
    const [name] = readdirSync(path.join(rootDir, "features")).filter((entry) => entry.endsWith(".md"));
    expect(readFileSync(path.join(rootDir, "features", name!), "utf8")).not.toContain("- repeat:");
  });
});
