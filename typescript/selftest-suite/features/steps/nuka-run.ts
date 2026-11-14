import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Given, Then, When } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// INNER project: the nukadoko project these steps drive with
// `nuka run` and `nuka report` as subprocesses. Its own
// `.nukadoko/export/allure-results/`, where `nuka report --format allure`
// writes, is the tree this file's own Then steps assert on, never the OUTER one this
// suite writes for itself when the swap track runs it (that one is
// selftest-suite/.nukadoko/export/allure-results/, and no step here ever
// reads it; see selftest-suite/nukadoko.config.ts's own comment).
const fixtureProjectDir = path.resolve(here, "..", "..", "fixture-project");

// The nukadoko CLI binary these steps drive the inner project with, always
// the built dist artifact, identical on both tracks. Only this suite's own
// registration import (features/steps/runtime.ts) differs between tracks;
// the `nuka` binary being driven does not.
const cliPath = path.resolve(here, "..", "..", "..", "dist", "cli.js");

Given("a clean copy of the fixture project's nukadoko state", async function (this: SelftestWorld) {
  // The allure writer never deletes an existing result file
  // (src/report/allure/writer.ts: "never delete an existing allure-results
  // directory"), so a leftover `.nukadoko/` from a previous run of this
  // very scenario would make "one result file per scenario" a fact about
  // every run since the state dir was last cleared, not about this run.
  await rm(path.join(fixtureProjectDir, ".nukadoko"), { recursive: true, force: true });
});

When("nuka run runs {string} in the fixture project", async function (this: SelftestWorld, feature: string) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "run", "--records", feature], {
      cwd: fixtureProjectDir,
    });
    this.nukaExitCode = 0;
    this.nukaStdout = stdout;
  } catch (error) {
    // execFile rejects on a non-zero exit code; the rejection still carries
    // the exit code and whatever stdout/stderr the process produced before
    // exiting, which the Then steps below need to report a useful failure
    // rather than only "something threw".
    const failure = error as { code?: number; stdout?: string };
    this.nukaExitCode = typeof failure.code === "number" ? failure.code : 1;
    this.nukaStdout = failure.stdout ?? "";
  }
});

When(
  "nuka report renders the newest run as Allure results in the fixture project",
  async function (this: SelftestWorld) {
    // A refusal or a crash rejects, and a rejected step is the failure to
    // report: nothing after it can read a report that was not written.
    await execFileAsync(process.execPath, [cliPath, "report", "--format", "allure"], { cwd: fixtureProjectDir });
  },
);

Then("the fixture project's allure-results holds no result file", async function (this: SelftestWorld) {
  const resultsDir = path.join(fixtureProjectDir, ".nukadoko", "export", "allure-results");
  const entries = await readdir(resultsDir).catch(() => []);
  const resultFiles = entries.filter((name) => name.endsWith("-result.json"));
  if (resultFiles.length > 0) {
    throw new Error(`expected no allure result file in ${resultsDir} before nuka report, found ${resultFiles.join(", ")}`);
  }
});

Then("the run exits {int}", function (this: SelftestWorld, expected: number) {
  if (this.nukaExitCode !== expected) {
    throw new Error(`expected nuka run to exit ${expected}, got ${this.nukaExitCode}: ${this.nukaStdout}`);
  }
});

Then(
  "the fixture project's allure-results has one result file per scenario",
  async function (this: SelftestWorld) {
    const scenarios = this.nukaStdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { steps: unknown[] });
    // One Allure result per scenario, its own steps nested inside it as
    // `steps[]` (map-scenario.ts's own `mapScenario`) -- never one per
    // executed step.
    const expectedFiles = scenarios.length;

    const resultsDir = path.join(fixtureProjectDir, ".nukadoko", "export", "allure-results");
    const entries = await readdir(resultsDir);
    // `*-result.json` only: the same directory also holds
    // `*-container.json` (src/report/allure/writer.ts's writeGroup) and
    // other allure assets, none of which are one-per-scenario either.
    const resultFiles = entries.filter((name) => name.endsWith("-result.json"));

    if (resultFiles.length !== expectedFiles) {
      throw new Error(
        `expected ${expectedFiles} allure result file(s) (one per scenario) in ${resultsDir}, found ${resultFiles.length}`,
      );
    }
  },
);
