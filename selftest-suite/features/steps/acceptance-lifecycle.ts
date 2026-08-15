import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { After, Given, Then, When } from "./runtime.js";

// Responsibility: selftest-suite/features/acceptance-lifecycle.feature's own
// glue -- a real `nuka run` + `nuka accept` (+ `nuka tend`, for two of the
// three scenarios) cycle against a fresh, disposable project, never a
// hand-assembled record: src/accept/render-record.ts is the only writer of
// the record format, and asserting against real output is what the rest of
// this suite already does (features/steps/nuka-run.ts's own header).
//
// State is kept in a plain module-local variable (`current` below), not on
// SelftestWorld (features/support/world.ts): a Cucumber World instance is
// created fresh per scenario regardless, and this suite's own scenarios
// already run one at a time, in one process, on both tracks (run-selftest.mjs
// spawns no `--parallel`; `nuka run` has no parallel execution of its own
// either), so a module-local variable is exactly as scoped to "one scenario
// at a time" as a World field would be, without adding a field to a shared
// file another part of this suite also has to read.
//
// ## Why a disposable project directory, not fixture-project itself
//
// Every other step file in this suite drives selftest-suite/fixture-project/
// directly (features/steps/nuka-run.ts's own header) because `nuka run`
// itself never touches git. `nuka accept` does: it refuses on anything but a
// clean git working tree, and `git -C <dir> status` walks up to the nearest
// `.git` regardless of `<dir>` itself, which would be this whole repository's
// own `.git` if run straight from fixture-project/ (no `.git` of its own) --
// making every scenario below depend on the ambient state of whatever else
// is being edited in this repository at the time, never a hermetic check.
// Each scenario below instead copies acceptance-lifecycle/ (fixture-project's
// own template subdirectory for this file) into a fresh directory nested
// under selftest-suite/ itself (mkdtemp with a `.tmp-accept-` prefix, gitignored
// the same way features/steps/allure-report.ts's own `.tmp-init-*` is), gives
// it its own `git init`, and only then runs `nuka run`/`nuka accept`/`nuka
// tend` inside it -- a real, isolated repository whose only history is what
// this file itself commits.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(here, "..", "..", "..");
const templateDir = path.resolve(here, "..", "..", "fixture-project", "acceptance-lifecycle");
const cliPath = path.join(repoRoot, "dist", "cli.js");

// Where acceptance.feature (the template's one feature file) lands inside a
// freshly copied project, depending on which side of `featuresDir`
// ("features", this template's own default) a scenario needs it on.
const FEATURE_RELATIVE_PATH = {
  inside: "features/acceptance.feature",
  outside: "acceptance/acceptance.feature",
} as const;

interface AcceptanceLifecycleState {
  readonly tempDir: string;
  readonly featureAbsolutePath: string;
  readonly featureRelativePath: string;
  acceptStdout: string;
  acceptStderr: string;
  recordRelativePath: string;
  tendStdout: string;
}

let current: AcceptanceLifecycleState | null = null;

function requireCurrent(): AcceptanceLifecycleState {
  if (current === null) {
    throw new Error("no fixture project has been set up yet (an earlier Given step should have run first)");
  }
  return current;
}

async function gitInit(dir: string): Promise<void> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir });
  await git(["init", "-q"]);
  // `--local` only (this call's own `cwd`): a selftest must never read or
  // write the machine's real git config.
  await git(["config", "user.email", "nukadoko-selftest@example.invalid"]);
  await git(["config", "user.name", "nukadoko selftest"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "initial"]);
}

interface NukaResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Tolerant of a non-zero exit the same way features/steps/nuka-run.ts's own
// When step is: execFile rejects on a non-zero exit code, but the rejection
// still carries the exit code and whatever stdout/stderr the process
// produced, which every Then step below needs to report a useful failure
// rather than only "something threw".
async function runNuka(args: readonly string[], cwd: string): Promise<NukaResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

// Copies the template into a fresh directory, places acceptance.feature
// either inside or outside `featuresDir`, and commits it all as a real git
// repository's initial commit -- everything every scenario below needs
// before its own first `nuka run`.
async function setUpProject(placement: "inside" | "outside"): Promise<AcceptanceLifecycleState> {
  const tempDir = await mkdtemp(path.join(suiteDir, ".tmp-accept-"));
  await cp(templateDir, tempDir, { recursive: true });

  const featureRelativePath = FEATURE_RELATIVE_PATH[placement];
  const featureAbsolutePath = path.join(tempDir, featureRelativePath);
  await mkdir(path.dirname(featureAbsolutePath), { recursive: true });
  await rename(path.join(tempDir, "acceptance.feature"), featureAbsolutePath);

  await gitInit(tempDir);

  return {
    tempDir,
    featureAbsolutePath,
    featureRelativePath,
    acceptStdout: "",
    acceptStderr: "",
    recordRelativePath: "",
    tendStdout: "",
  };
}

async function runThenAccept(state: AcceptanceLifecycleState): Promise<void> {
  const runResult = await runNuka(["run", state.featureRelativePath], state.tempDir);
  if (runResult.exitCode !== 0) {
    throw new Error(`expected the acceptance feature's own run to exit 0, got ${runResult.exitCode}: ${runResult.stdout}`);
  }

  const acceptResult = await runNuka(["accept", state.featureRelativePath], state.tempDir);
  if (acceptResult.exitCode !== 0) {
    throw new Error(`expected nuka accept to exit 0, got ${acceptResult.exitCode}: ${acceptResult.stdout} ${acceptResult.stderr}`);
  }
  state.acceptStdout = acceptResult.stdout;
  state.acceptStderr = acceptResult.stderr;
  state.recordRelativePath = acceptResult.stdout.trim();
}

// --- Scenario 1: accept names the choice that follows ---

Given(
  "a fixture project with a green run of an acceptance feature",
  { timeout: 30_000 },
  async function () {
    const state = await setUpProject("outside");
    const runResult = await runNuka(["run", state.featureRelativePath], state.tempDir);
    if (runResult.exitCode !== 0) {
      throw new Error(`expected the acceptance feature's own run to exit 0, got ${runResult.exitCode}: ${runResult.stdout}`);
    }
    current = state;
  },
);

When("nuka accept freezes that run", { timeout: 30_000 }, async function () {
  const state = requireCurrent();
  const acceptResult = await runNuka(["accept", state.featureRelativePath], state.tempDir);
  if (acceptResult.exitCode !== 0) {
    throw new Error(`expected nuka accept to exit 0, got ${acceptResult.exitCode}: ${acceptResult.stdout} ${acceptResult.stderr}`);
  }
  state.acceptStdout = acceptResult.stdout;
  state.acceptStderr = acceptResult.stderr;
});

Then("it names where the record landed", function () {
  const state = requireCurrent();
  const recordPath = state.acceptStdout.trim();
  if (!recordPath.endsWith(".md")) {
    throw new Error(`expected nuka accept's own stdout to be a record path ending in .md, got: ${JSON.stringify(state.acceptStdout)}`);
  }
  if (!state.acceptStderr.includes(recordPath)) {
    throw new Error(`expected the guidance on stderr to name the record it just wrote (${recordPath}); got: ${state.acceptStderr}`);
  }
});

Then("it names both homes the feature can now live in", function () {
  const state = requireCurrent();
  const guidance = state.acceptStderr;
  if (!/where it is|left where/i.test(guidance)) {
    throw new Error(`expected the guidance to name the feature's current home; got: ${guidance}`);
  }
  if (!guidance.includes("features/")) {
    throw new Error(`expected the guidance to name featuresDir ("features/"); got: ${guidance}`);
  }
});

// --- Scenarios 2 and 3: tend's silence, decided by placement ---

Given(
  "a fixture project with an accepted feature outside featuresDir",
  { timeout: 30_000 },
  async function () {
    const state = await setUpProject("outside");
    await runThenAccept(state);
    current = state;
  },
);

Given(
  "a fixture project with an accepted feature inside featuresDir",
  { timeout: 30_000 },
  async function () {
    const state = await setUpProject("inside");
    await runThenAccept(state);
    current = state;
  },
);

Given("that feature has changed since it was accepted", async function () {
  const state = requireCurrent();
  const original = await readFile(state.featureAbsolutePath, "utf8");
  await writeFile(state.featureAbsolutePath, `${original}\n  # changed after acceptance\n`);
});

When("nuka tend runs in the fixture project", { timeout: 30_000 }, async function () {
  const state = requireCurrent();
  const result = await runNuka(["tend", "--json"], state.tempDir);
  state.tendStdout = result.stdout;
});

interface TendIssueLike {
  readonly code: string;
  readonly file?: string;
  readonly message: string;
}

interface TendReportLike {
  readonly errors: readonly TendIssueLike[];
  readonly notes: readonly TendIssueLike[];
}

Then("it reports that the record no longer describes what is on disk", function () {
  const state = requireCurrent();
  const report = JSON.parse(state.tendStdout) as TendReportLike;
  const changed = report.errors.filter(
    (issue) => issue.code === "signoff-feature-changed" && issue.file === state.recordRelativePath,
  );
  if (changed.length !== 1) {
    throw new Error(
      `expected exactly one signoff-feature-changed error for ${state.recordRelativePath}, found ${changed.length}: ${state.tendStdout}`,
    );
  }
});

Then("it reports nothing about that feature's sign-off", function () {
  const state = requireCurrent();
  const report = JSON.parse(state.tendStdout) as TendReportLike;
  const aboutThisRecord = [...report.errors, ...report.notes].filter((issue) => issue.file === state.recordRelativePath);
  if (aboutThisRecord.length !== 0) {
    throw new Error(
      `expected nothing reported about ${state.recordRelativePath}'s sign-off, found: ${JSON.stringify(aboutThisRecord)}`,
    );
  }
});

// Untagged: this suite's other scenarios (features/nuka-run.feature) never
// set `current`, so this is a no-op for them -- cheap enough to run
// unconditionally rather than needing a tag this feature file's own fixed
// text has no room to carry.
After(async function () {
  if (current !== null) {
    await rm(current.tempDir, { recursive: true, force: true });
    current = null;
  }
});
