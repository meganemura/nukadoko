import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { After, Given, Then, When } from "./runtime.js";

// Responsibility: selftest-suite/features/same-scenario-across-runs.feature's
// own glue -- a real `nuka init` + `nuka run` + the real `allure` CLI cycle
// against a fresh, disposable project, never a hand-assembled report: this
// is the one place in this suite that reads Allure's own generated output
// back (`data/test-results/*.json`, written by @allurereport/plugin-awesome
// under whichever `-o` directory `allure generate` was given), because the
// claim under test -- "the same scenario is recognised from one run to the
// next" -- is a claim about Allure's own history/trend computation, not
// about anything nukadoko itself writes to allure-results/.
//
// ## Why a disposable project directory, not fixture-project itself
//
// Every scenario below needs its own `allurerc.mjs` with its own
// `historyPath`, and needs that history to start empty -- fixture-project/
// itself is shared with every other selftest scenario (features/nuka-
// run.feature), so a fresh project nested under selftest-suite/ itself
// (mkdtemp with a `.tmp-same-scenario-` prefix, gitignored the same way
// features/steps/allure-report.ts's own `.tmp-init-*` is) keeps this
// suite's own history.jsonl from ever mixing with another scenario's.
// `nuka init` runs for real inside it (never a hand-written config), which
// is what actually exercises `nuka init`'s own generated allurerc.mjs
// (`historyPath` included) rather than merely trusting its own unit tests.
//
// ## Why the fixture template has two features, not one
//
// toggle.feature's own single step reads an env var this file sets per
// `nuka run` invocation, never the feature text -- exactly what "the same
// scenario runs twice, with a different outcome" needs. outline.feature's
// own two rows never interpolate their own Examples column into any step
// text, so nothing but the Examples table itself can tell them apart --
// exactly the failure mode the third scenario below pins. Both templates
// are copied into every fresh project up front (`setUpProject`, below);
// which one actually runs is a `nuka run <feature>` argument, not a
// separate template per scenario.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(here, "..", "..", "..");
const templateFeaturesDir = path.resolve(here, "..", "..", "fixture-project", "same-scenario-across-runs", "features");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const allureBin = path.join(repoRoot, "node_modules", "allure", "cli.js");

interface SameScenarioState {
  readonly tempDir: string;
  reportCounter: number;
  lastReportDir: string | null;
}

let current: SameScenarioState | null = null;

function requireCurrent(): SameScenarioState {
  if (current === null) {
    throw new Error("no fixture project has been set up yet (the Given step should have run first)");
  }
  return current;
}

interface NukaResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Tolerant of a non-zero exit the same way features/steps/nuka-run.ts's own
// When step is: execFile rejects on a non-zero exit code, but the
// rejection still carries the exit code and whatever stdout/stderr the
// process produced, which callers below need to report a useful failure
// rather than only "something threw".
async function runNuka(args: readonly string[], cwd: string, extraEnv?: Record<string, string>): Promise<NukaResult> {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd, env });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function setUpProject(): Promise<SameScenarioState> {
  const tempDir = await mkdtemp(path.join(suiteDir, ".tmp-same-scenario-"));
  const initResult = await runNuka(["init"], tempDir);
  if (initResult.exitCode !== 0) {
    throw new Error(`expected nuka init to exit 0, got ${initResult.exitCode}: ${initResult.stdout} ${initResult.stderr}`);
  }
  // Merged into the features/ directory `nuka init` just created (its own
  // steps/ subdirectory included) -- `cp`'s own recursive copy of a
  // directory writes its *contents* into an existing destination directory
  // rather than nesting a second copy inside it.
  await cp(templateFeaturesDir, path.join(tempDir, "features"), { recursive: true });
  return { tempDir, reportCounter: 0, lastReportDir: null };
}

// The allure-results directory only -- never `.nukadoko` as a whole
// (features/steps/nuka-run.ts's own "clean copy" step does that, but that
// would delete allure-history.jsonl too, discarding the exact history this
// suite exists to prove survives). The writer recreates this directory on
// its own on the next `nuka run` (src/report/allure/writer.ts's own
// `mkdirSync`), so nothing needs to recreate it here.
async function clearAllureResults(state: SameScenarioState): Promise<void> {
  await rm(path.join(state.tempDir, ".nukadoko", "export", "allure-results"), { recursive: true, force: true });
}

async function generateReport(state: SameScenarioState): Promise<void> {
  state.reportCounter += 1;
  const outputRelative = `report-${state.reportCounter}`;
  // No results-directory argument: `allure generate`'s own default glob
  // (`./**/allure-results`) already finds `.nukadoko/export/allure-results`
  // from `state.tempDir` (its basename alone is what the glob matches),
  // the same invocation shape features/steps/allure-report.ts's own "the
  // fixture project's Allure report is generated" step already relies on.
  await execFileAsync(process.execPath, [allureBin, "generate", "-o", outputRelative], { cwd: state.tempDir });
  state.lastReportDir = path.join(state.tempDir, outputRelative);
}

async function runToggleThenGenerate(state: SameScenarioState, outcome: "pass" | "fail"): Promise<void> {
  const result = await runNuka(["run", "features/toggle.feature"], state.tempDir, {
    NUKADOKO_SELFTEST_TOGGLE: outcome,
  });
  const expectedExit = outcome === "pass" ? 0 : 1;
  if (result.exitCode !== expectedExit) {
    throw new Error(
      `expected the toggleable check's own run to exit ${expectedExit} (outcome: ${outcome}), got ${result.exitCode}: ${result.stdout} ${result.stderr}`,
    );
  }
  await generateReport(state);
}

interface ScenarioTestResult {
  readonly name?: string;
  readonly fullName?: string;
  readonly historyId?: string;
  readonly transition?: string;
  readonly labels?: readonly { readonly name: string; readonly value: string }[];
}

// Only `nukadoko.grain: scenario` results (map-scenario.ts's own
// `mapScenario`) -- every step's own test sits in the exact same
// data/test-results/ directory, and this suite's own claim is about the
// scenario-level test specifically, never about a step's.
async function readScenarioResults(reportDir: string): Promise<ScenarioTestResult[]> {
  const dir = path.join(reportDir, "data", "test-results");
  const fileNames = await readdir(dir);
  const all = await Promise.all(
    fileNames
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8")) as ScenarioTestResult),
  );
  return all.filter((result) => result.labels?.some((label) => label.name === "nukadoko.grain" && label.value === "scenario"));
}

// --- Given (shared by all three scenarios) ---

Given("a fixture project whose report keeps its history", { timeout: 30_000 }, async function () {
  current = await setUpProject();
});

// --- Scenarios 1 and 2: the toggleable check, twice ---

When("the same feature runs twice, green and then red", { timeout: 120_000 }, async function () {
  const state = requireCurrent();
  await runToggleThenGenerate(state, "pass");
  await clearAllureResults(state);
  await runToggleThenGenerate(state, "fail");
});

When("the same feature runs twice, red and then green", { timeout: 120_000 }, async function () {
  const state = requireCurrent();
  await runToggleThenGenerate(state, "fail");
  await clearAllureResults(state);
  await runToggleThenGenerate(state, "pass");
});

function requireLastReportDir(state: SameScenarioState): string {
  if (state.lastReportDir === null) {
    throw new Error("no report has been generated yet (an earlier When step should have run first)");
  }
  return state.lastReportDir;
}

async function requireSingleScenarioResult(state: SameScenarioState): Promise<ScenarioTestResult> {
  const results = await readScenarioResults(requireLastReportDir(state));
  if (results.length !== 1) {
    throw new Error(`expected exactly one scenario-level result in the generated report, found ${results.length}: ${JSON.stringify(results)}`);
  }
  return results[0]!;
}

Then("the report marks that scenario as regressed from its own last run", async function () {
  const state = requireCurrent();
  const result = await requireSingleScenarioResult(state);
  if (result.transition !== "regressed") {
    throw new Error(`expected the scenario-level result's own transition to be "regressed", got ${JSON.stringify(result.transition)}: ${JSON.stringify(result)}`);
  }
});

Then("the report marks that scenario as fixed from its own last run", async function () {
  const state = requireCurrent();
  const result = await requireSingleScenarioResult(state);
  if (result.transition !== "fixed") {
    throw new Error(`expected the scenario-level result's own transition to be "fixed", got ${JSON.stringify(result.transition)}: ${JSON.stringify(result)}`);
  }
});

// --- Scenario 3: a Scenario Outline's own two rows ---

When("a Scenario Outline with two rows runs once", { timeout: 60_000 }, async function () {
  const state = requireCurrent();
  const result = await runNuka(["run", "features/outline.feature"], state.tempDir);
  if (result.exitCode !== 0) {
    throw new Error(`expected outline.feature's own run to exit 0, got ${result.exitCode}: ${result.stdout} ${result.stderr}`);
  }
  await generateReport(state);
});

Then("the report counts two scenarios, neither one a retry of the other", async function () {
  const state = requireCurrent();
  const results = await readScenarioResults(requireLastReportDir(state));
  if (results.length !== 2) {
    throw new Error(`expected two scenario-level results (one per outline row), found ${results.length}: ${JSON.stringify(results)}`);
  }
  const historyIds = new Set(results.map((result) => result.historyId));
  if (historyIds.size !== 2) {
    throw new Error(`expected the two outline rows to have distinct historyIds, got: ${JSON.stringify(results.map((r) => r.historyId))}`);
  }
});

// Untagged: this suite's other scenarios (features/nuka-run.feature) never
// set `current`, so this is a no-op for them.
After(async function () {
  if (current !== null) {
    await rm(current.tempDir, { recursive: true, force: true });
    current = null;
  }
});
