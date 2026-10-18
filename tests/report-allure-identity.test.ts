import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an Allure history keeps going across the move from
// results written during the run to results `nuka report` renders after
// it. tests/fixtures/allure-identity.golden.json holds the (fullName,
// historyId, testCaseId) of every result the run-time writer wrote for
// tests/fixtures/allure-identity-project (a plain scenario and a Scenario
// Outline of two rows, run once in each of two environments), captured
// from that writer at the commit before `nuka report` replaced it, with
// `allure: {}` added to the fixture's config. A render of the same run
// must reproduce every triple exactly; a change that moves one starts
// every project's Allure history over.

interface Identity {
  fullName: string;
  historyId: string;
  testCaseId: string;
}

describe("nuka report --format allure keeps the run-time writer's identity", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("allure-identity-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reproduces fullName, historyId, and testCaseId of every result, for an outline over two environments", async () => {
    const run = (args: string[]) => runCli(args, { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(await run(["run", "--env", "staging", "--env", "production"])).toBe(0);
    expect(await run(["report", "--format", "allure"])).toBe(0);
    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const identities: Identity[] = readdirSync(resultsDir)
      .filter((name) => name.endsWith("-result.json"))
      .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")) as Identity)
      .map(({ fullName, historyId, testCaseId }) => ({ fullName, historyId, testCaseId }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.historyId.localeCompare(b.historyId));
    const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "allure-identity.golden.json"), "utf8")) as Identity[];
    expect(golden).toHaveLength(6);
    expect(identities).toEqual(golden);
  });
});
