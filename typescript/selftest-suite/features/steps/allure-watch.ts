import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { After, Given, Then } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

// Responsibility: stage 3 of this suite -- proves `allure watch`, started
// before a run, shows that run once `nuka report --format allure` renders
// it, and nothing before: a run writes nothing into `allure-results`
// itself. The live browser reads 0 before the run, the directory is still
// empty once the run has finished, and the live report's count reaches the
// run's scenario count only after the render.
//
// ## Why no `.goto()` or `.reload()` anywhere below
//
// `allure watch` pushes updates over SSE (`/__live_reload`); the browser's
// own listener does `window.location.reload()` on receipt (measured fact).
// If a step here called `.goto()` or `.reload()`
// itself, a rising count would no longer distinguish "the watch pushed an
// update" from "this test just reloaded the page and saw whatever was on
// disk at that moment" -- the whole point of this scenario. The report
// page is opened exactly once, in `the live report is open in a browser`
// below, and never touched again; every later read relies on Playwright's
// own auto-retrying `expect` (standalone import from "playwright/test",
// confirmed to auto-retry outside a `test()` block) to observe the DOM the
// SSE listener's own reload already produced -- never a manual
// `setTimeout`/poll loop, which would only be a proxy for "did we wait long
// enough", not evidence the watch process did anything at all.
//
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureProjectDir = path.resolve(here, "..", "..", "fixture-project");
const allureBin = path.resolve(here, "..", "..", "..", "node_modules", "allure", "cli.js");
const resultsDir = path.join(fixtureProjectDir, ".nukadoko", "export", "allure-results");
// A directory of its own, never fixture-project's `.nukadoko/allure-report`
// (that one belongs to allure-report.ts's `allure generate`, run only in
// the separate @allure-report scenario) -- `allure watch` deletes its own
// `--output` directory outright on startup
// (`rm(config.output, { recursive: true })`,
// node_modules/allure/dist/commands/watch.js), so sharing one would race
// stage 2's own generated report if both scenarios ever ran close together.
const watchReportDir = path.join(fixtureProjectDir, ".nukadoko", "allure-watch-report");

// One Allure result per scenario (map-scenario.ts's own `mapScenario`, the
// same total nuka-run.ts's own "one result file per scenario" Then step
// checks against the on-disk directory), its own steps nested inside it --
// the live report tallies one entry per scenario too, so its own final
// count has to match this total, not the step count.
function countScenarios(stdout: string): number {
  return stdout.split("\n").filter((line) => line.length > 0).length;
}

After({ tags: "@allure-watch" }, async function (this: SelftestWorld) {
  // Attempted regardless of how far the scenario got: a failed assertion
  // partway through must never leave a browser or an `allure watch`
  // process behind.
  await this.page?.close().catch(() => undefined);
  await this.browser?.close().catch(() => undefined);
  this.browser = null;
  this.page = null;

  if (this.watchProcess !== null && this.watchProcess.exitCode === null) {
    this.watchProcess.kill();
    await new Promise<void>((resolve) => {
      this.watchProcess?.once("exit", () => resolve());
    });
  }
  this.watchProcess = null;
});

Given(
  "allure watch is running on the fixture project's empty allure-results",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    // `allure watch` refuses to start against a missing results directory
    // but accepts an empty one (measured fact -- the same constraint
    // `nuka init` already works around, see
    // src/cli/init.ts's own comment). The preceding "a clean copy of the
    // fixture project's nukadoko state" step removed `.nukadoko` outright,
    // so this has to exist again before watch can start, and it has to be
    // genuinely empty: that emptiness is what the very next Then step (0
    // results before any run starts) checks.
    await mkdir(resultsDir, { recursive: true });

    const watch = spawn(
      process.execPath,
      [allureBin, "watch", resultsDir, "--output", watchReportDir, "--port", "0"],
      { cwd: fixtureProjectDir },
    );
    this.watchProcess = watch;

    this.watchBaseUrl = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      function onData(chunk: Buffer): void {
        buffered += chunk.toString();
        // Same pattern allure-report.ts's own HTTP server already uses:
        // read the real port back out of the process's own startup line
        // rather than picking one, so a concurrent or leftover run of this
        // suite can never collide with it.
        const match = /Allure is running on (\S+)/.exec(buffered);
        // The capture group is checked rather than asserted: a regex match
        // says nothing to the type system about group 1 existing, and a
        // future edit to the pattern could drop it without any other signal.
        const url = match?.[1];
        if (url !== undefined) {
          watch.stdout?.off("data", onData);
          resolve(url);
        }
      }
      watch.stdout?.on("data", onData);
      watch.once("error", reject);
      watch.once("exit", (code) => {
        reject(new Error(`allure watch exited (code ${code}) before it reported a URL`));
      });
    });
  },
);

Given("the live report is open in a browser", { timeout: 30_000 }, async function (this: SelftestWorld) {
  if (this.watchBaseUrl === "") {
    throw new Error("no watch URL: the allure watch Given step did not run first");
  }
  this.browser = await chromium.launch();
  const page = await this.browser.newPage();
  // `allure watch`'s default plugin id is "awesome"
  // (node_modules/allure/dist/commands/watch.js), regardless of whether the
  // fixture project has its own allurerc.mjs (confirmed empirically both
  // with and without one present) -- so the report itself, not the static
  // server's own directory-listing shell at the base URL, lives one path
  // segment under it.
  await page.goto(`${this.watchBaseUrl}/awesome/`);
  await page.getByTestId("tab-all").waitFor({ state: "visible", timeout: 15_000 });
  this.page = page;
});

Then("the live report shows 0 results before any run starts", async function (this: SelftestWorld) {
  if (this.page === null) {
    throw new Error("no page: the live-report Given step did not run first");
  }
  // Checked, not assumed. With
  // zero result files, Allure's own Awesome plugin still renders
  // `tab-all` (confirmed empirically against a genuinely empty
  // allure-results directory), reading "Total 0" rather than omitting the
  // element -- so this asserts that exact text, not merely presence or
  // absence of the element.
  await expect(this.page.getByTestId("tab-all")).toHaveText("Total 0");
});

Then(
  "the live report's final result count matches the number of scenarios",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    if (this.page === null) {
      throw new Error("no page: earlier steps did not run first");
    }
    const totalScenarios = countScenarios(this.nukaStdout);
    // The step's own timeout has to exceed the `expect`'s own 15s, or
    // cucumber-js's 5s default kills the step before the wait inside it
    // gets the chance to succeed.
    await expect(this.page.getByTestId("tab-all")).toHaveText(`Total ${totalScenarios}`, { timeout: 15_000 });
  },
);
