import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { After, Given, Then, When } from "./runtime.js";
import { startServer, type RunningServer } from "../../fixture-project/playwright-suite/server.js";

// Responsibility: selftest-suite/features/playwright-suite.feature's own
// glue -- proves docs/spec.md's "The second door: a Playwright Test suite"
// for real. selftest-suite/fixture-project/playwright-suite/ shares one
// implementation (its own features/steps/lib/cart.ts) between a genuine
// `playwright test` run and a genuine `nuka run`/`nuka do`, never a
// stand-in for either. State kept in a plain module-local variable
// (`current` below), the same reasoning features/steps/acceptance-
// lifecycle.ts's own header already gives: this suite's own scenarios run
// one at a time, in one process, on both tracks.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixtureDir = path.resolve(here, "..", "..", "fixture-project", "playwright-suite");
const nukaCliPath = path.join(repoRoot, "dist", "cli.js");
const playwrightCliPath = path.join(repoRoot, "node_modules", "playwright", "cli.js");

interface ProcResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// NODE_OPTIONS is dropped from every spawn's own env, not just Playwright's:
// run-selftest.mjs injects `--import tsx` into it for the baseline track's
// own cucumber-js process only (its own header comment), so forwarding it
// unchanged would be the one thing this scenario's subprocesses inherit
// differently between tracks. Neither `nuka` nor `playwright test` needs
// it -- each already loads its own `.ts` files its own way -- so dropping
// it keeps every subprocess below identical on both tracks.
function buildEnv(extra: Record<string, string>): Record<string, string> {
  const { NODE_OPTIONS: _dropped, ...rest } = process.env;
  return { ...rest, ...extra } as Record<string, string>;
}

// Tolerant of a non-zero exit the same way every other step file in this
// suite is (features/steps/nuka-run.ts's own header): execFile rejects on a
// non-zero exit code, but the rejection still carries the exit code and
// whatever stdout/stderr the process produced, which the Then steps below
// need to report a useful failure rather than only "something threw".
async function run(command: string, args: readonly string[], extraEnv: Record<string, string>): Promise<ProcResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: fixtureDir, env: buildEnv(extraEnv) });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

interface PlaywrightSuiteState {
  readonly server: RunningServer;
  playwrightResult: ProcResult | null;
  runResult: ProcResult | null;
  doResult: ProcResult | null;
}

let current: PlaywrightSuiteState | null = null;

function requireCurrent(): PlaywrightSuiteState {
  if (current === null) {
    throw new Error("no fixture server has been started yet (the Given step should have run first)");
  }
  return current;
}

function portEnv(state: PlaywrightSuiteState): Record<string, string> {
  return { NUKADOKO_SELFTEST_PW_PORT: String(state.server.port) };
}

Given("the playwright-suite fixture's request server is running", async function () {
  // Own .nukadoko state, never left over from a previous selftest run --
  // the allure writer never deletes an existing results directory (same
  // reason features/steps/nuka-run.ts's own "clean copy" step gives), so a
  // stale one here would only ever be dead weight on disk, never a wrong
  // answer (the step record ids this file reads come off `nuka run`'s own
  // stdout, not off a directory listing) -- cleaned anyway to keep repeated
  // local runs from accumulating it.
  await rm(path.join(fixtureDir, ".nukadoko"), { recursive: true, force: true });
  const server = await startServer();
  current = { server, playwrightResult: null, runResult: null, doResult: null };
});

When("the Playwright suite runs against it", { timeout: 60_000 }, async function () {
  const state = requireCurrent();
  state.playwrightResult = await run(process.execPath, [playwrightCliPath, "test"], portEnv(state));
});

Then("the Playwright suite passes", function () {
  const state = requireCurrent();
  const result = state.playwrightResult;
  if (result === null || result.exitCode !== 0) {
    throw new Error(`expected the Playwright suite to exit 0, got ${result?.exitCode}: ${result?.stdout} ${result?.stderr}`);
  }
});

When("nuka run runs the fixture's cart feature against it", { timeout: 30_000 }, async function () {
  const state = requireCurrent();
  state.runResult = await run(process.execPath, [nukaCliPath, "run", "features/cart.feature"], portEnv(state));
});

Then("that run passes too", function () {
  const state = requireCurrent();
  const result = state.runResult;
  if (result === null || result.exitCode !== 0) {
    throw new Error(`expected nuka run to exit 0, got ${result?.exitCode}: ${result?.stdout} ${result?.stderr}`);
  }
});

interface ScenarioRecordStep {
  readonly text: string;
  readonly step_record_id: string;
}

interface ScenarioRecordLine {
  readonly steps: readonly ScenarioRecordStep[];
}

interface StepRecordLike {
  readonly result: unknown;
}

function requireRunResult(state: PlaywrightSuiteState): ProcResult {
  if (state.runResult === null) {
    throw new Error("no nuka run result yet (an earlier When step should have run first)");
  }
  return state.runResult;
}

Then("the add-item step record carries the count the shared helper returned", async function () {
  const state = requireCurrent();
  const result = requireRunResult(state);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(`expected exactly one scenario record on stdout, got ${lines.length}: ${result.stdout}`);
  }
  const scenario = JSON.parse(lines[0]!) as ScenarioRecordLine;
  const addItemStep = scenario.steps.find((step) => step.text === "an item is added");
  if (addItemStep === undefined) {
    throw new Error(`expected a step record for "an item is added", found: ${JSON.stringify(scenario.steps)}`);
  }

  const recordPath = path.join(fixtureDir, ".nukadoko", "records", "steps", addItemStep.step_record_id, "record.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")) as StepRecordLike;
  const helperResult = record.result as { count?: unknown } | null;
  if (helperResult === null || helperResult.count !== 1) {
    throw new Error(
      `expected the add-item step record's own result (the shared helper's return value) to carry count: 1, got: ${JSON.stringify(record.result)}`,
    );
  }
});

When("nuka do opens a cart on its own", { timeout: 30_000 }, async function () {
  const state = requireCurrent();
  state.doResult = await run(process.execPath, [nukaCliPath, "do", "open-cart", "--args", "{}"], portEnv(state));
});

Then("that step record carries the id the shared helper returned", function () {
  const state = requireCurrent();
  const result = state.doResult;
  if (result === null || result.exitCode !== 0) {
    throw new Error(`expected nuka do to exit 0, got ${result?.exitCode}: ${result?.stdout} ${result?.stderr}`);
  }
  const record = JSON.parse(result.stdout) as StepRecordLike;
  const helperResult = record.result as { id?: unknown } | null;
  if (helperResult === null || typeof helperResult.id !== "string" || !/^cart-\d+$/.test(helperResult.id)) {
    throw new Error(
      `expected nuka do's own step record to carry an id like "cart-N" (the shared helper's return value), got: ${JSON.stringify(record.result)}`,
    );
  }
});

// Untagged: this suite's other scenarios (features/nuka-run.feature,
// features/acceptance-lifecycle.feature, features/same-scenario-across-
// runs.feature) never set `current`, so this is a no-op for them.
After(async function () {
  if (current !== null) {
    await current.server.close();
    current = null;
  }
});
