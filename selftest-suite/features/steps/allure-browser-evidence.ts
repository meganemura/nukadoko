import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { chromium, type Page } from "playwright";
import { After, Before, Then, When } from "./runtime.js";
import type { SelftestWorld } from "../support/world.js";

// Responsibility: stage 4 of this suite -- 0.1.0's own
// Playwright-native redesign left four kinds of evidence behind a
// browser-driven run: a trace per step/hook, that trace's own calls as
// child steps ("actions"), `page_events` counts as parameters, and a hook
// that touches the browser as its own fixture. Stage 2 (allure-report.ts)
// and stage 3 (allure-watch.ts) both read reports built entirely from
// pure-step scenarios, so none of the four had ever reached an actual
// browser screen. This file is the first thing that opens all four.
//
// ## Two chromiums, easy to confuse (same caution stage 1's own header
// gives the two allure-results trees -- this file follows that pattern)
//
// - OUTER: the chromium this file's own Before/After hook below launches,
//   used only to read the Allure report this scenario's own Then steps
//   check (`this.browser`/`this.page`, the same World fields stage 2 and
//   stage 3 already share their own Before/After hooks with).
// - INNER: a *second*, entirely separate chromium `nuka run` launches deep
//   inside the fixture-project subprocess this scenario's own When step
//   spawns (fixture-project/features/browser-evidence.feature's own step
//   and Before hook, both real `ctx.page()`/`this.openPage()` calls). It is
//   gone by the time any assertion below runs, since that subprocess has
//   already exited -- nothing here ever touches it directly. Everything
//   below only reads what that run left behind on disk, through the Allure
//   report the OUTER chromium opens.
//
// ## Why `data:` URLs (browser-evidence.feature's own steps, not this
// file) -- and why no third HTTP server
//
// `page.goto("data:text/html,...")` is what produces a `goto` action in
// the trace; `page.setContent(...)` never does (measured while writing
// visits-noisy-data-url.ts, not assumed). Serving a test app over HTTP
// would need a server of its own: stage 2 already runs one for the report
// and stage 3 runs `allure watch`'s own, and a third here would exist for
// no evidence a `data:` URL doesn't already provide.
//
// ## Why every assertion below reads `test-result-step-title`, never the
// wider `test-result-step` testid stage 2 already uses for section:/poll:
//
// `test-result-step` wraps a whole node's subtree, nested children
// included. The Before hook's own fixture -- titled exactly "Before" --
// nests its own `goto data:text/html,before-hook` action inside it, so a
// `test-result-step` locator filtered with `hasText` (Playwright's own
// case-insensitive substring match) matches "Before" against that nested
// child's text too (`"...before-hook"` contains `"before"`), and matches
// "goto" against the fixture's own container as well as either literal
// `goto` step. Confirmed empirically while writing this file: naive
// `test-result-step` + `hasText` filters here overcounted 2x and 3x.
// `test-result-step-title` carries only one step's own title text, nothing
// nested, so filtering it is exact -- this is why the two checks below
// anchor their regexes (`/^Before$/`, `/^goto /`) rather than trusting
// `hasText`'s own substring match alone.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixtureProjectDir = path.resolve(here, "..", "..", "fixture-project");
// A directory of its own, never stage 2's own `.nukadoko/allure-report`:
// this scenario's own "a clean copy of the fixture project's nukadoko
// state" step (reused from nuka-run.ts) wipes `.nukadoko` outright before
// either scenario runs, so the two could not actually collide in practice
// -- named apart anyway, the same defensive separation allure-watch.ts's
// own header already gives its own report directory, for a reader who
// only skims one file at a time.
const reportDir = path.join(fixtureProjectDir, ".nukadoko", "allure-report-browser-evidence");
const allureBin = path.join(repoRoot, "node_modules", "allure", "cli.js");

// --- NDJSON scenario records, same shape/parsing stage 2 and stage 3
// already duplicate into their own files (never shared, same reasoning:
// each scenario's own step file stays self-contained) ---

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

// --- HTTP server lifecycle (Before/After hook) -- duplicated from
// allure-report.ts's own `serveDirectory`/`stopServer` rather than shared,
// same self-containment precedent allure-watch.ts already set for its own
// port-reading logic. See allure-report.ts's own header for why the port is
// never fixed: a fixed port collides with a concurrent or
// leftover run. ---

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

Before({ tags: "@allure-browser", timeout: 30_000 }, async function (this: SelftestWorld) {
  await mkdir(reportDir, { recursive: true });
  const served = await serveDirectory(reportDir);
  this.httpServer = served.process;
  this.reportUrl = served.url;
  this.browser = await chromium.launch();
});

After({ tags: "@allure-browser", timeout: 30_000 }, async function (this: SelftestWorld) {
  // Attempted regardless of what ran before: a failed step must never leak
  // the OUTER browser or a listening server (the INNER one is already gone
  // once its own subprocess exits, per this file's own header).
  await this.page?.close().catch(() => undefined);
  await this.browser?.close().catch(() => undefined);
  await stopServer(this.httpServer);
  this.browser = null;
  this.page = null;
  this.httpServer = null;
});

// --- report navigation helpers, duplicated from allure-report.ts (its own
// header explains why a brand new page, not a reused one, opens every time:
// sessionStorage-backed tree state survives a same-tab `.goto()`) ---

async function openReportPage(world: SelftestWorld): Promise<Page> {
  if (world.browser === null) {
    throw new Error("no browser: the @allure-browser Before hook did not run");
  }
  await world.page?.close().catch(() => undefined);
  const page = await world.browser.newPage();
  await page.goto(world.reportUrl);
  await page.getByTestId("tab-all").waitFor({ state: "visible", timeout: 15_000 });
  world.page = page;
  return page;
}

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

async function openStepDetail(world: SelftestWorld, stepText: string): Promise<Page> {
  const page = await openReportPage(world);
  await expandAllTreeSections(page);
  await page.getByTestId("tree-leaf-title").filter({ hasText: stepText }).first().click();
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
  return page;
}

function theExecutedStep(nukaStdout: string): RunStepRecord {
  const [step] = allSteps(parseRunRecords(nukaStdout));
  if (step === undefined) {
    throw new Error("expected browser-evidence.feature's run to have executed exactly one step; found none");
  }
  return step;
}

// --- zip validity (deliberate scope: confirm the attachment reads back as
// a real zip, never what its own trace.trace entry says happened -- proving
// the trace survived the trip through Allure intact is enough; full content
// verification is not attempted) ---

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_EOCD_FIXED_SIZE = 22;
const ZIP_LOCAL_FILE_HEADER_FIXED_SIZE = 30;
// A zip's own comment field can run up to this many bytes (same bound
// src/context/trace-actions.ts's own zip reader uses) -- how far back to
// search for the end-of-central-directory record's own signature.
const ZIP_MAX_COMMENT_LENGTH = 65535;

/** A fresh, narrower reimplementation of the same "walk the zip's own
 * structure by hand, no new dependency" approach
 * src/context/trace-actions.ts's own zip reader already uses -- not a reuse of that file, which reads
 * one *named* entry (`trace.trace`) and returns its decompressed bytes.
 * This function never inspects what any entry contains: it decompresses
 * the *first* entry only (`inflateRawSync`, catching a throw) and checks
 * the result against that entry's own stored CRC-32 (`node:zlib`'s own
 * `crc32`, no new dependency either), enough to prove the bytes downloaded
 * from the report are a zip Node's own `zlib` can actually read, never what
 * that entry says happened. The CRC-32 check earns its keep: measured while
 * writing this file, a single flipped byte inside a DEFLATE stream often
 * still decompresses without throwing (raw DEFLATE carries no integrity
 * check of its own), so `inflateRawSync` succeeding is not by itself
 * evidence the bytes are what the trace actually wrote -- the zip's own
 * stored checksum is. */
function isReadableZip(buffer: Buffer): boolean {
  if (buffer.length < ZIP_EOCD_FIXED_SIZE) {
    return false;
  }
  const searchFloor = Math.max(0, buffer.length - ZIP_EOCD_FIXED_SIZE - ZIP_MAX_COMMENT_LENGTH);
  let eocdOffset = -1;
  for (let offset = buffer.length - ZIP_EOCD_FIXED_SIZE; offset >= searchFloor; offset--) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    return false;
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0 || centralDirectoryOffset + 46 > buffer.length) {
    return false;
  }
  if (buffer.readUInt32LE(centralDirectoryOffset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
    return false;
  }

  const compressionMethod = buffer.readUInt16LE(centralDirectoryOffset + 10);
  const storedCrc32 = buffer.readUInt32LE(centralDirectoryOffset + 16);
  const compressedSize = buffer.readUInt32LE(centralDirectoryOffset + 20);
  const localHeaderOffset = buffer.readUInt32LE(centralDirectoryOffset + 42);
  if (localHeaderOffset + ZIP_LOCAL_FILE_HEADER_FIXED_SIZE > buffer.length) {
    return false;
  }
  if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    return false;
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + ZIP_LOCAL_FILE_HEADER_FIXED_SIZE + fileNameLength + extraFieldLength;
  if (dataStart + compressedSize > buffer.length) {
    return false;
  }
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  try {
    const decompressed = compressionMethod === 0 ? compressed : inflateRawSync(compressed);
    return crc32(decompressed) === storedCrc32;
  } catch {
    return false;
  }
}

// --- the 4 checks this stage verifies ---

When(
  "the browser-evidence report is generated and opened in a browser",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    // cwd is fixture-project itself, same reason allure-report.ts's own
    // identically-shaped step already gives: Allure 3's own config
    // auto-detection reads the current working directory, not `-o`'s
    // target. No allurerc.mjs is set up here (unlike stage 2's own
    // scenario) -- nothing below reads a category, so nothing needs one.
    await execFileAsync(process.execPath, [allureBin, "generate", "-o", path.join(".nukadoko", "allure-report-browser-evidence")], {
      cwd: fixtureProjectDir,
    });
    await openReportPage(this);
  },
);

Then(
  "the step's own trace attachment downloads as a non-empty, readable zip",
  { timeout: 30_000 },
  async function (this: SelftestWorld) {
    const step = theExecutedStep(this.nukaStdout);
    const page = await openStepDetail(this, step.text);
    await page.getByTestId("test-result-tab-attachments").click();

    const traceHeader = page.getByTestId("test-result-attachment-header").filter({ hasText: "trace" });
    if ((await traceHeader.count()) < 1) {
      throw new Error(
        `expected a "trace" attachment on ${JSON.stringify(step.text)}'s own Attachments tab; found none (missing attachment)`,
      );
    }

    // A playwright-trace attachment always renders exactly two buttons
    // here (TrAttachmentInfo.tsx): PwTraceButton first, which opens
    // https://trace.playwright.dev in a new tab and needs live internet
    // access this check must never depend on, then the plain download
    // button last. `.last()` picks the download button on purpose, never
    // the PwTrace one.
    const downloadButton = traceHeader.getByRole("button").last();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      downloadButton.click(),
    ]);
    const downloadPath = await download.path();
    if (downloadPath === null) {
      throw new Error(
        `the trace attachment's own browser download produced no local file (missing attachment)`,
      );
    }

    const buffer = await readFile(downloadPath);
    if (buffer.length === 0) {
      throw new Error("the trace attachment downloaded as 0 bytes (zero bytes)");
    }
    if (!isReadableZip(buffer)) {
      throw new Error(
        `the trace attachment downloaded (${buffer.length} bytes) but does not read back as a valid zip (not a readable zip)`,
      );
    }
    // stderr only, never stdout -- same reasoning as allure-watch.ts's own
    // comment: a stray stdout write here would corrupt the swap track's
    // own NDJSON when this whole suite runs as the outer `nuka run`
    // process.
    console.error(`selftest-browser: trace attachment downloaded, ${buffer.length} bytes, reads back as a valid zip`);
  },
);

Then("the before hook shows up as a fixture in the report", async function (this: SelftestWorld) {
  const step = theExecutedStep(this.nukaStdout);
  const page = await openStepDetail(this, step.text);
  await page.getByTestId("test-result-tab-overview").click();

  // Exact match, not `hasText`'s own substring match -- this file's own
  // header explains why (the hook's own nested "before-hook" action text
  // would otherwise match "Before" too).
  const fixtureCount = await page
    .getByTestId("test-result-step-title")
    .filter({ hasText: /^Before$/ })
    .count();
  if (fixtureCount < 1) {
    throw new Error(
      'expected this scenario\'s own Before hook to render as a "Before" fixture on this step\'s own detail page; found none',
    );
  }
});

Then("the trace's own goto action appears as a child step", async function (this: SelftestWorld) {
  const step = theExecutedStep(this.nukaStdout);
  const page = await openStepDetail(this, step.text);
  await page.getByTestId("test-result-tab-overview").click();

  const gotoCount = await page
    .getByTestId("test-result-step-title")
    .filter({ hasText: /^goto / })
    .count();
  if (gotoCount < 1) {
    throw new Error('expected at least one "goto ..." child step under this test result; found none');
  }
});

const PAGE_EVENT_PARAMETERS: ReadonlyArray<readonly [label: string, field: string]> = [
  ["console errors (observed)", "console_errors"],
  ["page errors (observed)", "page_errors"],
  ["failed requests (observed)", "failed_requests"],
];

async function metadataParameterValue(page: Page, label: string): Promise<string | null> {
  const item = page
    .getByTestId("metadata-item")
    .filter({ has: page.getByTestId("metadata-item-key").filter({ hasText: label }) });
  if ((await item.count()) < 1) {
    return null;
  }
  return (await item.getByTestId("metadata-item-value").innerText()).trim();
}

Then("the page_events counts in the report match the step's own receipt", async function (this: SelftestWorld) {
  const step = theExecutedStep(this.nukaStdout);
  if (step.receipt === null) {
    throw new Error("expected browser-evidence.feature's run to have executed a step with a receipt; it had none");
  }

  // The expected counts come from the step's own receipt.json on disk, not
  // a number hardcoded here -- visits-noisy-data-url.ts's own header
  // explains why console_errors in particular is not a fixed number.
  const receiptPath = path.join(fixtureProjectDir, ".nukadoko", "receipts", step.receipt, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    page_events?: Record<string, readonly unknown[]>;
  };
  const pageEvents = receipt.page_events;
  if (pageEvents === undefined) {
    throw new Error(`expected receipt ${step.receipt} to carry page_events; it carried none`);
  }

  const page = await openStepDetail(this, step.text);
  await page.getByTestId("test-result-tab-overview").click();

  for (const [label, field] of PAGE_EVENT_PARAMETERS) {
    const expectedCount = (pageEvents[field] ?? []).length;
    if (expectedCount === 0) {
      // pageEventCount (src/report/allure/map-scenario.ts) omits an empty
      // category as a parameter entirely, never shows it as "0".
      continue;
    }
    const actual = await metadataParameterValue(page, label);
    if (actual !== String(expectedCount)) {
      throw new Error(
        `expected the "${label}" parameter to read "${expectedCount}" (this step's own receipt.page_events.${field}.length); got ${
          actual === null ? "no such parameter" : JSON.stringify(actual)
        }`,
      );
    }
  }
});
