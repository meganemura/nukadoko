import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Locator, type Page } from "playwright";
import { After, Before, Given, Then, When } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

// Responsibility: stage 2 of this suite -- opens the
// Allure report `nuka run` writes for selftest-suite/fixture-project's own
// mixed.feature run in a real, headless browser and reads back only
// data-dependent content (a count, a tree row, a status). docs/spec.md's
// own gap, before this file existed: "An official HTML report or a
// third-party formatter has not been exercised against this stream" was
// true of the *messages* emitter's stream (still is; unrelated to this
// file) and, separately, no one had opened the Allure report the way an
// actual reader would either -- this file is the first thing that does.
//
// ## Why a real HTTP server, not `file://`
//
// The generated report is a single-page app that `fetch()`s its own
// `widgets/*.json` on load. Under `file://` that fetch fails outright
// ("URL scheme 'file' is not supported"), but the SPA's *shell* -- header,
// footer, the "Allure Report"/"Powered by Allure Report" boilerplate --
// still renders regardless, because none of that text depends on the fetch
// having succeeded. A locator on that boilerplate would pass against a
// completely broken report and prove nothing; this file is why the Before
// hook below spawns a real static file server instead of pointing a browser
// at the report directory directly.
//
// ## Why every assertion below reads a `data-testid`, and reads *content*
//
// The report's tree rows and statuses carry no `role` Playwright's own
// `getByRole` can reach (`treeitem`/`row`/`status` all count 0 there), and
// their CSS classes are hashed per build (`styles_status-failed__CIBqD`,
// changes every `allure generate`), so `data-testid` is the only stable
// handle. Every Then step below reads a count, a tree row's own text, or a
// status badge -- never boilerplate -- for the same reason the HTTP server
// exists: a check that would still pass with the server down is not
// checking anything.
//
// ## Why the HTTP server's port is never fixed
//
// A fixed port collides with a
// concurrent run of this same suite or a leftover process from a killed
// one. `python3 -m http.server 0` asks the OS for whichever port is free
// right now; `-u` (unbuffered) makes its own "Serving HTTP on ... port N
// ..." line reach this process's stdout the instant it is printed rather
// than whenever Python's stdout buffer happens to flush, which is what lets
// the Before hook below read the real port back out reliably.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(here, "..", "..", "..");
const fixtureProjectDir = path.resolve(here, "..", "..", "fixture-project");
const reportDir = path.join(fixtureProjectDir, ".nukadoko", "allure-report");

// Both binaries invoked the same way run-selftest.mjs and nuka-run.ts
// already invoke `dist/cli.js` and cucumber.js's own bin: `process.execPath`
// plus the script's own path, never relying on a shebang or `.bin`
// symlink's own execute bit.
const cliPath = path.join(repoRoot, "dist", "cli.js");
const allureBin = path.join(repoRoot, "node_modules", "allure", "cli.js");

// --- NDJSON scenario records (the same "scenario name -> status" shape
// run-selftest.mjs's own swap track already parses `nuka run`'s stdout
// into), read here for each step's own text/status/receipt rather than
// just its scenario-level status -- the tab-count check needs a per-step
// tally, and the receipt-attachment check needs a specific step's own
// receipt id. ---

interface RunStepRecord {
  readonly text: string;
  readonly status: "passed" | "failed" | "skipped" | "undefined" | "ambiguous";
  readonly receipt: string | null;
}

interface RunScenarioRecord {
  readonly scenario: string;
  readonly steps: readonly RunStepRecord[];
}

function parseRunRecords(stdout: string): RunScenarioRecord[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunScenarioRecord);
}

function allSteps(records: readonly RunScenarioRecord[]): RunStepRecord[] {
  return records.flatMap((record) => record.steps);
}

// --- HTTP server lifecycle (Before/After hook) ---

interface ServedReport {
  readonly process: ChildProcess;
  readonly url: string;
}

function serveDirectory(directory: string): Promise<ServedReport> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1", "--directory", directory]);
    let settled = false;
    let buffered = "";

    function onData(chunk: Buffer): void {
      buffered += chunk.toString();
      const match = /Serving HTTP on \S+ port (\d+)/.exec(buffered);
      if (match && !settled) {
        settled = true;
        proc.stdout?.off("data", onData);
        resolve({ process: proc, url: `http://127.0.0.1:${match[1]}/` });
      }
    }

    proc.stdout?.on("data", onData);
    proc.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    proc.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`python3 -m http.server exited (code ${code}) before it reported a port`));
      }
    });
  });
}

function stopServer(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (proc === null || proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
    proc.kill();
  });
}

Before({ tags: "@allure-report", timeout: 30_000 }, async function (this: SelftestWorld) {
  // Created empty, before `allure generate` has ever run: the server only
  // needs the directory to exist, not to already hold a report (the
  // "When ... is generated and opened" step below populates it before any
  // step navigates a browser there).
  await mkdir(reportDir, { recursive: true });
  const served = await serveDirectory(reportDir);
  this.httpServer = served.process;
  this.reportUrl = served.url;
  this.browser = await chromium.launch();
});

After({ tags: "@allure-report", timeout: 30_000 }, async function (this: SelftestWorld) {
  // Attempted regardless of what ran before: a failed step or a Before
  // hook that only got partway through must never leak a browser process
  // or a listening server.
  await this.page?.close().catch(() => undefined);
  await this.browser?.close().catch(() => undefined);
  await stopServer(this.httpServer);
  this.browser = null;
  this.page = null;
  this.httpServer = null;
});

// --- setup steps ---

Given(
  "the fixture project has nukadoko's own allurerc.mjs",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    // `nuka init` refuses outright when nukadoko.config.ts already exists
    // (fixture-project's own), and Node's package self-reference resolution
    // that lets a project's own files `import "nukadoko"` only resolves
    // inside this repo's own directory tree (confirmed empirically: the
    // same import fails when tried from a directory symlinked in from
    // outside it) -- so allurerc.mjs is produced by running the real `nuka
    // init` in a disposable directory nested under selftest-suite/ itself,
    // then copying just that one file out. Regenerated every run rather
    // than committed: it always matches whatever categories.ts currently
    // says, the same reason examples/allure/allurerc.mjs has its own drift
    // test, and it never needs a review diff of its own when categories.ts
    // changes. Gitignored (this repo's own .gitignore) so a run never dirties
    // the working tree.
    const tempDir = await mkdtemp(path.join(suiteDir, ".tmp-init-"));
    try {
      await execFileAsync(process.execPath, [cliPath, "init"], { cwd: tempDir });
      await copyFile(path.join(tempDir, "allurerc.mjs"), path.join(fixtureProjectDir, "allurerc.mjs"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

When(
  "the fixture project's Allure report is generated and opened in a browser",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    // cwd is fixture-project itself: Allure 3's own config auto-detection
    // (allurerc.{js,mjs,cjs,json,yaml,yml}) reads the current working
    // directory, not `-o`'s target, so allurerc.mjs must sit exactly where
    // this command runs from for the categories it declares to apply at
    // all (docs/spec.md "Allure emitter").
    await execFileAsync(process.execPath, [allureBin, "generate", "-o", path.join(".nukadoko", "allure-report")], {
      cwd: fixtureProjectDir,
    });
    await openReportPage(this);
  },
);

// --- tree helpers shared by the Then steps below ---

// Every Then step below that needs the report starts here rather than
// calling `.goto()` on whatever page a previous step left open: the SPA
// persists its own tree open/closed state in `sessionStorage`, which
// survives a same-tab `.goto()` (confirmed empirically -- reusing one page
// across steps made a later step's own `expandAllTreeSections` toggle an
// already-open group *closed* instead of a no-op, because the "opened" CSS
// class it reads hadn't finished re-rendering yet on that reload). A brand
// new Playwright page is a brand new top-level browsing context with empty
// `sessionStorage`, so every check below starts from the exact same
// deterministic state (everything collapsed except a group that already
// contains a failure) that the very first look at this report found.
async function openReportPage(world: SelftestWorld): Promise<Page> {
  if (world.browser === null) {
    throw new Error("no browser: the @allure-report Before hook did not run");
  }
  await world.page?.close().catch(() => undefined);
  const page = await world.browser.newPage();
  await page.goto(world.reportUrl);
  // The one place file://'s own trap (this file's header comment) is
  // actively guarded against: waiting for a data-dependent element to
  // become visible, not a fixed sleep, is what actually proves the SPA's
  // own widgets/*.json fetch succeeded rather than merely that its static
  // shell painted.
  await page.getByTestId("tab-all").waitFor({ state: "visible", timeout: 15_000 });
  world.page = page;
  return page;
}

// Allure 3's tree collapses every group by default except one that already
// contains a failure; a scenario or step whose own group never gets
// expanded is invisible to `getByTestId("tree-leaf-title")`, so every Then
// step below that reads the tree calls this first rather than trusting
// whatever happens to already be open.
async function expandAllTreeSections(page: Page): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const arrows = page.getByTestId("tree-arrow");
    const count = await arrows.count();
    let clickedAny = false;
    for (let i = 0; i < count; i++) {
      const arrow = arrows.nth(i);
      const opened = await arrow.evaluate(
        (button) => button.querySelector("svg")?.getAttribute("class")?.includes("opened") ?? false,
      );
      if (!opened) {
        await arrow.click();
        clickedAny = true;
        await page.waitForTimeout(100);
      }
    }
    if (!clickedAny) break;
  }
}

// Scopes a query to one scenario's own rows. `tree-section-title` (the
// group header) and its own leaves are DOM *siblings* under a shared
// parent, not nested one inside the other -- `tree-content` is the sibling
// that actually holds them (confirmed against the real generated report) --
// so a plain `.locator()` chained off the header would search the whole
// page, not just this scenario's own subtree, and silently double-count a
// step whose text happens to repeat across scenarios (mixed.feature has
// exactly this: two different scenarios both call the same native step).
function sectionContent(page: Page, scenarioName: string): Locator {
  const header = page.getByTestId("tree-section-title").filter({ hasText: scenarioName });
  return header.locator(
    "xpath=./ancestor::*[@data-testid='tree-section'][1]/following-sibling::*[@data-testid='tree-content'][1]",
  );
}

async function assertTabText(page: Page, testId: string, expectedText: string): Promise<void> {
  const actual = (await page.getByTestId(testId).innerText()).trim();
  if (actual !== expectedText) {
    throw new Error(`expected ${testId} to read "${expectedText}", got "${actual}"`);
  }
}

async function openStepDetail(world: SelftestWorld, stepText: string): Promise<Page> {
  const page = await openReportPage(world);
  await expandAllTreeSections(page);
  await page.getByTestId("tree-leaf-title").filter({ hasText: stepText }).first().click();
  // `.count()` below (unlike `.click()`) never auto-waits -- it reads
  // whatever is in the DOM the instant it's called -- so without this, a
  // check that runs no further click of its own (this file's own child-step
  // check does not) can read the detail page before its own content has
  // finished rendering and see zero of everything. The heading is the
  // earliest data-dependent element the detail view renders, so waiting for
  // it is the cheapest signal that the navigation has actually landed.
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
  return page;
}

// --- the 5 checks this stage verifies, plus a pin for a known display
// limit (a 6th, deliberately kept separate from "the 5") ---

Then("the tab counts match the step statuses nuka run reported", async function (this: SelftestWorld) {
  const page = await openReportPage(this);

  const steps = allSteps(parseRunRecords(this.nukaStdout));
  const expected = {
    all: steps.length,
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
  };

  await assertTabText(page, "tab-all", `Total ${expected.all}`);
  await assertTabText(page, "tab-passed", `Passed ${expected.passed}`);
  await assertTabText(page, "tab-failed", `Failed ${expected.failed}`);
  await assertTabText(page, "tab-skipped", `Skipped ${expected.skipped}`);
});

Then("every scenario is a tree group and every step is one of its leaves", async function (this: SelftestWorld) {
  const page = await openReportPage(this);
  await expandAllTreeSections(page);

  for (const record of parseRunRecords(this.nukaStdout)) {
    const groupCount = await page.getByTestId("tree-section-title").filter({ hasText: record.scenario }).count();
    if (groupCount < 1) {
      throw new Error(`expected a tree group for scenario "${record.scenario}", found none`);
    }

    const content = sectionContent(page, record.scenario);
    const expectedCountByText = new Map<string, number>();
    for (const step of record.steps) {
      expectedCountByText.set(step.text, (expectedCountByText.get(step.text) ?? 0) + 1);
    }
    for (const [text, expectedCount] of expectedCountByText) {
      const actualCount = await content.getByTestId("tree-leaf-title").filter({ hasText: text }).count();
      if (actualCount !== expectedCount) {
        throw new Error(
          `expected ${expectedCount} tree leaf(ves) reading "${text}" under scenario "${record.scenario}", found ${actualCount}`,
        );
      }
    }
  }
});

Then(
  "the failing step's receipt.json attachment is readable and matches its own receipt",
  async function (this: SelftestWorld) {
    const failingStep = allSteps(parseRunRecords(this.nukaStdout)).find((step) => step.status === "failed");
    if (failingStep === undefined || failingStep.receipt === null) {
      throw new Error("expected mixed.feature's run to have exactly one failed step with a receipt");
    }

    const page = await openStepDetail(this, failingStep.text);
    await page.getByTestId("test-result-tab-attachments").click();
    await page.getByTestId("test-result-attachment-header").filter({ hasText: "receipt.json" }).click();

    // Not "an attachment named receipt.json exists" -- its own rendered
    // content must actually name the receipt this run wrote: nukadoko's
    // central artifact must survive the
    // trip to a browser, not merely appear in a file listing.
    const content = await page.getByTestId("code-attachment-content").innerText();
    if (!content.includes(failingStep.receipt)) {
      throw new Error(
        `expected the receipt.json attachment's own content to contain this step's receipt id "${failingStep.receipt}"; got: ${content}`,
      );
    }
  },
);

Then(
  "the failing step is categorized as {string}, not {string}",
  async function (this: SelftestWorld, expectedCategory: string, unexpectedCategory: string) {
    const failingStep = allSteps(parseRunRecords(this.nukaStdout)).find((step) => step.status === "failed");
    if (failingStep === undefined) {
      throw new Error("expected mixed.feature's run to have a failed step");
    }

    const page = await openStepDetail(this, failingStep.text);
    await page.getByTestId("test-result-tab-overview").click();

    const categoryCount = await page.getByText(`Category: ${expectedCategory}`).count();
    if (categoryCount < 1) {
      throw new Error(`expected the failing step's own detail page to show "Category: ${expectedCategory}"`);
    }
    const bodyText = await page.innerText("body");
    if (bodyText.includes(unexpectedCategory)) {
      throw new Error(`expected the failing step's own detail page not to mention "${unexpectedCategory}"`);
    }
  },
);

Then("the timeline step's section and poll appear as its own child steps", async function (this: SelftestWorld) {
  const page = await openStepDetail(this, "exists after a section and a poll");

  // "test-result-step" is the child-step timeline nested directly under this
  // step's own test result -- one level shallower than before step became
  // the Allure test-result unit (docs/spec.md "Allure emitter"), which is
  // exactly what this checks: the section/poll this step's own fixture
  // recorded must show up here, not two levels down inside a scenario-wide
  // test that no longer exists.
  const childSteps = page.getByTestId("test-result-step");
  const sectionCount = await childSteps.filter({ hasText: "section:" }).count();
  const pollCount = await childSteps.filter({ hasText: "poll:" }).count();
  if (sectionCount < 1 || pollCount < 1) {
    throw new Error(
      `expected a "section:"-named and a "poll:"-named child step under this test result; found ${await childSteps.count()} child step(s) total`,
    );
  }
});

Then("the before-hook-stopped scenario's step shows skipped, not failed", async function (this: SelftestWorld) {
  const page = await openReportPage(this);
  await expandAllTreeSections(page);

  // Known, accepted limit, pinned rather than hidden (docs/spec.md "Allure
  // emitter"): step became the
  // Allure test-result unit, so a scenario a Before hook stops has no
  // scenario-level test left for that hook's own failure to turn red --
  // every one of its steps shows skipped instead. `nuka run`'s own exit
  // code and record.json still say "failed"; only the report's own display
  // reads this way, and that gap is what this pins so a future change to
  // either direction is a deliberate one, not a silent regression.
  const content = sectionContent(page, "a before hook stops the scenario before its own step runs");
  const skippedCount = await content.locator('[data-testid="tree-leaf-status-skipped"]').count();
  const failedCount = await content.locator('[data-testid="tree-leaf-status-failed"]').count();
  if (skippedCount !== 1 || failedCount !== 0) {
    throw new Error(
      `expected the before-hook-stopped scenario's own step to show skipped, not failed: skipped=${skippedCount} failed=${failedCount}`,
    );
  }
});
