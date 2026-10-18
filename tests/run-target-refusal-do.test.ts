import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

const FEATURE = [
  "Feature: Targets",
  "  Scenario: one",
  "    Given a step",
  "",
  "  Scenario Outline: two <n>",
  "    Given a step",
  "",
  "    Examples:",
  "      | n |",
  "      | 1 |",
  "      | 2 |",
  "",
].join("\n");

let rootDir: string;

beforeEach(async () => {
  rootDir = await copyFixtureToTempDir("environments-project");
  await writeFile(path.join(rootDir, "features/a.feature"), FEATURE);
  await writeFile(path.join(rootDir, "features/empty.feature"), "Feature: Nothing yet\n");
  await mkdir(path.join(rootDir, "no features"));
  await mkdir(path.join(rootDir, "acceptance"));
});

afterEach(async () => {
  await removeTempDir(rootDir);
});

async function run(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run", ...argv], { rootDir, stdout, stderr });
  return { exitCode, stderr: stderr.text() };
}

describe("nuka run names the next step when a target selects nothing", () => {
  it("drops :line from a directory target and keeps the other targets and --env", async () => {
    expect(await run(["features:3", "features/a.feature:2", "no features:1", "--env", "staging"])).toEqual({
      exitCode: 2,
      stderr:
        '":line" has no meaning for a directory: features:3 names a directory, not a feature file\n' +
        "do: nuka run features features/a.feature:2 'no features' --env staging\n",
    });
  });

  it("lists the lines a scenario or an Examples row starts on", async () => {
    expect(await run(["features/a.feature:99"])).toEqual({
      exitCode: 2,
      stderr: "No scenario found at features/a.feature:99\ndo: Name a line a scenario or an Examples row starts on: 2, 10, 11.\n",
    });
  });

  it("says to add a scenario when nothing in the file can run", async () => {
    expect(await run(["features/empty.feature:1"])).toEqual({
      exitCode: 2,
      stderr: "No scenario found at features/empty.feature:1\ndo: Add a scenario to features/empty.feature; nothing in it can run yet.\n",
    });
  });

  it("names every scanned directory when none holds a .feature file", async () => {
    expect(await run(["no features", "acceptance"])).toEqual({
      exitCode: 2,
      stderr:
        `no .feature file was found while scanning "no features" and "acceptance" (resolved to ${path.join(rootDir, "no features")}, ${path.join(rootDir, "acceptance")}); nothing can run\n` +
        "do: Add a .feature file under no features or acceptance.\n",
    });
  });

  it("gives nuka check the same do line for a directory with no .feature file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "acceptance"], { rootDir, stdout, stderr });
    expect({ exitCode, stderr: stderr.text() }).toEqual({
      exitCode: 2,
      stderr:
        `nuka check: no .feature file was found while scanning "acceptance" (resolved to ${path.join(rootDir, "acceptance")}); nothing can run\n` +
        "do: Add a .feature file under acceptance.\n",
    });
  });
});
