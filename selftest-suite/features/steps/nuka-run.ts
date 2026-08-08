import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Given, Then, When } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// INNER project (selftest-suite task spec, "2 つの nukadoko、2 つの
// allure-results" section): the nukadoko project these steps drive with
// `nuka run` as a subprocess. Its own `.nukadoko/allure-results/` is the
// tree this file's own Then step asserts on, never the OUTER one this
// suite writes for itself when the swap track runs it (that one is
// selftest-suite/.nukadoko/allure-results/, and no step here ever reads
// it; see selftest-suite/nukadoko.config.ts's own comment).
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
  // very scenario would make "one result file per step" a fact about every
  // run since the state dir was last cleared, not about this run.
  await rm(path.join(fixtureProjectDir, ".nukadoko"), { recursive: true, force: true });
});

When("nuka run runs {string} in the fixture project", async function (this: SelftestWorld, feature: string) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "run", feature], {
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

Then("the run exits {int}", function (this: SelftestWorld, expected: number) {
  if (this.nukaExitCode !== expected) {
    throw new Error(`expected nuka run to exit ${expected}, got ${this.nukaExitCode}: ${this.nukaStdout}`);
  }
});

Then("the fixture project's allure-results has one result file per executed step", async function (this: SelftestWorld) {
  const lines = this.nukaStdout.split("\n").filter((line) => line.length > 0);
  const totalSteps = lines.reduce((sum, line) => sum + (JSON.parse(line).steps as unknown[]).length, 0);

  const resultsDir = path.join(fixtureProjectDir, ".nukadoko", "allure-results");
  const entries = await readdir(resultsDir);
  // `*-result.json` only: the same directory also holds `*-container.json`
  // (src/report/allure/writer.ts's writeGroup) and other allure assets,
  // none of which are one-per-step.
  const resultFiles = entries.filter((name) => name.endsWith("-result.json"));

  if (resultFiles.length !== totalSteps) {
    throw new Error(
      `expected ${totalSteps} allure result file(s) in ${resultsDir}, found ${resultFiles.length}`,
    );
  }
});
