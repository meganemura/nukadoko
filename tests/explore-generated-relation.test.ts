import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka explore` of a relation whose source is drawn. The
// fixture project's counter loses the second add of every sequence, so
// adding the same numbers in reverse order can end on another total.

describe("nuka explore: a relation with a generated source", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir !== undefined) await removeTempDir(rootDir);
    rootDir = undefined;
  });

  async function explore(args: string[]) {
    rootDir ??= await copyFixtureToTempDir("explore-relation-project");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["explore", "features/reverse.ts", ...args], { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("prints both scenarios at the shortest length, and the same seed repeats them", async () => {
    const first = await explore(["--seed", "1", "--runs", "20", "--length", "6"]);
    expect(first).toEqual({
      exitCode: 1,
      stdout: [
        "# nuka explore features/reverse.ts --seed 1 --runs 20 --length 6",
        '# Relation "adding in reverse order reaches the same total" failed: relate returned false for source results [{"total":1},{"total":1}] and follow results [{"total":0},{"total":0}]',
        "# Run 1 of 20 failed with 2 source steps. Shrunk to 2 source steps in 18 attempts.",
        '  Scenario: (name me) source of "adding in reverse order reaches the same total"',
        "    * 1 is added",
        "    * 0 is added",
        "",
        '  Scenario: (name me) follow of "adding in reverse order reaches the same total"',
        "    * 0 is added",
        "    * 1 is added",
        "",
      ].join("\n"),
      stderr: 'Failed: relation "adding in reverse order reaches the same total". Both scenarios are on stdout.\n',
    });
    expect(await explore(["--seed", "1", "--runs", "20", "--length", "6"])).toEqual(first);
  });

  it("passes with one step per sequence, where order cannot matter", async () => {
    expect(await explore(["--seed", "1", "--runs", "5", "--length", "1"])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr:
        'Passed: relation "adding in reverse order reaches the same total", 5 runs, seed 1. ' +
        "Rerun: nuka explore features/reverse.ts --seed 1 --runs 5 --length 1\n",
    });
  });
});
