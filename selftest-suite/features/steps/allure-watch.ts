import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { After, Given, Then, When } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

// Responsibility: selftest-watch task spec's stage 3 -- proves `allure
// watch` (README, docs/spec.md: "step ごとに更新される") actually pushes an
// update to an already-open browser tab WHILE a run is still executing,
// not only that a finished report reads correctly (allure-report.ts's own
// stage 2 already covers that, by reading a report only after `nuka run`
// has already returned). The one fact this file exists to catch: a count
// read partway through a run that is neither 0 nor the run's own final
// total. If that reading is never captured, this scenario has proven
// nothing about liveness and must fail loudly, not pass on a technicality
// (the final Then step below enforces this directly).
//
// ## Why no `.goto()` or `.reload()` anywhere below
//
// `allure watch` pushes updates over SSE (`/__live_reload`); the browser's
// own listener does `window.location.reload()` on receipt (measured fact,
// selftest-watch task spec). If a step here called `.goto()` or `.reload()`
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
// ## Why `nuka run` is spawned here, never awaited, until an explicit later step
//
// Awaiting `nuka run` before checking the report would mean nothing is
// ever observed until the run is already over -- indistinguishable from
// stage 2. The run is spawned in `nuka run runs ... without waiting for it
// to finish` below and only collected in `I wait for that run to finish`;
// every step in between still has a live child process, which the mid-run
// assertion below double-checks (`exitCode === null`) rather than assuming.
//
// ## Why features/slow.feature exists at all
//
// See fixture-project/features/steps/slow-thing.ts's own header: ordinary
// fixture steps run in a few milliseconds, well under `allure watch`'s own
// 300ms poll interval, so a run of them writes every result file before
// the first poll ever fires and the report jumps straight from 0 to the
// final count in one screen paint -- there is no in-between to observe.
// Do not point the When step below at passing.feature or mixed.feature.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureProjectDir = path.resolve(here, "..", "..", "fixture-project");
const cliPath = path.resolve(here, "..", "..", "..", "dist", "cli.js");
const allureBin = path.resolve(here, "..", "..", "..", "node_modules", "allure", "cli.js");
const resultsDir = path.join(fixtureProjectDir, ".nukadoko", "allure-results");
// A directory of its own, never fixture-project's `.nukadoko/allure-report`
// (that one belongs to allure-report.ts's `allure generate`, run only in
// the separate @allure-report scenario) -- `allure watch` deletes its own
// `--output` directory outright on startup
// (`rm(config.output, { recursive: true })`,
// node_modules/allure/dist/commands/watch.js), so sharing one would race
// stage 2's own generated report if both scenarios ever ran close together.
const watchReportDir = path.join(fixtureProjectDir, ".nukadoko", "allure-watch-report");

function parseStepTotal(stdout: string): number {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .reduce((sum, line) => sum + (JSON.parse(line).steps as unknown[]).length, 0);
}

After({ tags: "@allure-watch" }, async function (this: SelftestWorld) {
  // Attempted regardless of how far the scenario got: a failed assertion
  // partway through must never leave a browser, an `allure watch` process,
  // or a still-running `nuka run` child behind (selftest-watch task spec:
  // "watch のプロセスも run の子プロセスも残らない").
  await this.page?.close().catch(() => undefined);
  await this.browser?.close().catch(() => undefined);
  this.browser = null;
  this.page = null;

  if (this.runProcess !== null && this.runProcess.exitCode === null) {
    this.runProcess.kill();
  }
  this.runProcess = null;

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
    // but accepts an empty one (measured fact, selftest-watch task spec --
    // the same constraint `nuka init` already works around, see
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
        // suite can never collide with it (selftest-watch task spec,
        // decision 5).
        const match = /Allure is running on (\S+)/.exec(buffered);
        if (match !== null) {
          watch.stdout?.off("data", onData);
          resolve(match[1]);
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
  // Decision 6 of the selftest-watch task spec: checked, not assumed. With
  // zero result files, Allure's own Awesome plugin still renders
  // `tab-all` (confirmed empirically against a genuinely empty
  // allure-results directory), reading "Total 0" rather than omitting the
  // element -- so this asserts that exact text, not merely presence or
  // absence of the element.
  await expect(this.page.getByTestId("tab-all")).toHaveText("Total 0");
});

When(
  "nuka run runs {string} in the fixture project, without waiting for it to finish",
  function (this: SelftestWorld, feature: string) {
    const proc = spawn(process.execPath, [cliPath, "run", feature], { cwd: fixtureProjectDir });
    this.runProcess = proc;

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Resolves, never rejects: this promise is only awaited by a later step
    // ("I wait for that run to finish"), well after this step itself has
    // already returned, so a rejection here would surface as an unhandled
    // promise rejection instead of a step failure. Resolving with the exit
    // code either way lets that later step report a real failure the
    // normal way, through the same `nukaExitCode`/`nukaStdout` fields
    // nuka-run.ts's own Then steps already read.
    this.runCompletion = new Promise((resolve) => {
      proc.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    // No `await` above: returning immediately, with the child still
    // running, is the entire mechanism (selftest-watch task spec, decision
    // 3) -- awaiting here would mean the run is already over by the time
    // any step after this one runs, identical to stage 2.
  },
);

Then(
  "the live report's result count rises above 0 while the run is still going",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    if (this.page === null || this.runProcess === null) {
      throw new Error("no page or run process: earlier steps did not run first");
    }
    // The one assertion this whole scenario exists for. `expect(...)`'s own
    // auto-retry (never a manual poll loop -- selftest-watch task spec,
    // decision 2) waits for the SSE-pushed reload to land; reading the
    // count immediately afterward, then confirming the child process has
    // not exited yet, is what tells a report that updated *during* the run
    // apart from one that only happened to update by the time this step
    // got around to looking. The step's own timeout has to exceed the
    // `expect`'s own 20s: cucumber-js's default step timeout is 5s and
    // would otherwise kill this step on a loaded machine before the 20s
    // wait inside it ever got the chance to succeed.
    await expect(this.page.getByTestId("tab-all")).toHaveText(/Total [1-9]\d*/, { timeout: 20_000 });
    const text = await this.page.getByTestId("tab-all").innerText();
    const match = /Total (\d+)/.exec(text);
    if (match === null) {
      throw new Error(`could not read a count out of tab-all's own text "${text}"`);
    }
    this.midRunResultCount = Number(match[1]);
    if (this.runProcess.exitCode !== null) {
      throw new Error(
        `nuka run had already exited (code ${this.runProcess.exitCode}) by the time this step read the ` +
          "report; this proves nothing about a mid-run update -- see fixture-project/features/steps/slow-thing.ts",
      );
    }
  },
);

When("I wait for that run to finish", { timeout: 60_000 }, async function (this: SelftestWorld) {
  if (this.runCompletion === null) {
    throw new Error("no run in flight: the earlier When step did not run first");
  }
  const result = await this.runCompletion;
  this.nukaExitCode = result.code;
  this.nukaStdout = result.stdout;
  // Reuses the same two World fields nuka-run.ts's own Then steps already
  // read ("the run exits {int}", "...one result file per executed step"),
  // so this scenario shares those checks below instead of duplicating
  // either one.
});

Then(
  "the live report's final result count matches the number of executed steps",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    if (this.page === null) {
      throw new Error("no page: earlier steps did not run first");
    }
    const totalSteps = parseStepTotal(this.nukaStdout);
    // Same reasoning as the mid-run Then step above: the step's own
    // timeout has to exceed the `expect`'s own 15s, or cucumber-js's 5s
    // default kills the step before the wait inside it gets the chance to
    // succeed.
    await expect(this.page.getByTestId("tab-all")).toHaveText(`Total ${totalSteps}`, { timeout: 15_000 });

    // Decision 6's other half, and the actual proof this scenario exists to
    // deliver (selftest-watch task spec: "途中の観測が 0 でも総数でもない
    // ことが、ライブであることの証拠"). Only checkable now that totalSteps
    // is known: a mid-run reading of 0 would mean nothing had rendered yet,
    // and a reading equal to totalSteps would mean the run had already
    // finished by the time it was taken -- either way this scenario would
    // not have shown anything a finished-report read (stage 2) doesn't
    // already show.
    if (this.midRunResultCount === null) {
      throw new Error("no mid-run result count was ever captured -- this scenario proved nothing about liveness");
    }
    // stderr only, never stdout: this suite's own baseline track parses
    // cucumber-js's `--format json` stdout as one JSON document and its
    // swap track parses `nuka run`'s stdout as NDJSON (run-selftest.mjs),
    // so any stray stdout write from a step would corrupt one or both.
    console.error(
      `selftest-watch: observed 0 -> ${this.midRunResultCount} -> ${totalSteps} while features/slow.feature ran`,
    );
    if (this.midRunResultCount <= 0 || this.midRunResultCount >= totalSteps) {
      throw new Error(
        `expected the mid-run count (${this.midRunResultCount}) to be strictly between 0 and the total (${totalSteps})`,
      );
    }
  },
);
