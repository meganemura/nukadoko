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

// --- Scenario 4: two features made green by one run, accepted in turn ---

interface TwoFeatureAcceptanceState {
  readonly tempDir: string;
  readonly featureRelativePaths: readonly [string, string];
  readonly acceptResults: NukaResult[];
}

let currentTwoFeature: TwoFeatureAcceptanceState | null = null;

function requireCurrentTwoFeature(): TwoFeatureAcceptanceState {
  if (currentTwoFeature === null) {
    throw new Error("no two-feature fixture project has been set up yet (an earlier Given step should have run first)");
  }
  return currentTwoFeature;
}

Given(
  "a fixture project with two acceptance features made green by one run",
  { timeout: 30_000 },
  async function () {
    const tempDir = await mkdtemp(path.join(suiteDir, ".tmp-accept-"));
    await cp(templateDir, tempDir, { recursive: true });

    // The template's own .gitignore excludes every `.md` file (kept that
    // way for scenarios 1-3, which never accept a second feature in the
    // same tree and so never need to see whether an accepted record counts
    // as dirty). This scenario is the opposite case on purpose: its whole
    // point is that an accepted record must NOT block the next accept, and
    // that only means something if the record is actually untracked and
    // not silently hidden from git by this ignore rule -- the same reason
    // a real project's own .gitignore (`nuka init`'s own, see
    // src/cli/init.ts) never excludes anything but the state directory.
    await writeFile(path.join(tempDir, ".gitignore"), ".nukadoko/\n");

    // Two feature files, not one, both outside featuresDir (the same
    // "outside" placement FEATURE_RELATIVE_PATH already uses) -- what this
    // scenario needs is two features accepted from the same run, and
    // where they sit relative to featuresDir is not what it is about.
    const acceptanceDir = path.join(tempDir, "acceptance");
    await mkdir(acceptanceDir, { recursive: true });
    const templateFeature = await readFile(path.join(tempDir, "acceptance.feature"), "utf8");
    await rm(path.join(tempDir, "acceptance.feature"));
    const featureRelativePaths = ["acceptance/a.feature", "acceptance/b.feature"] as const;
    for (const relativePath of featureRelativePaths) {
      // Distinct Feature: names -- a failure below should name which of
      // the two features it is about without a reader having to diff file
      // contents to tell them apart.
      const named = templateFeature.replace(
        "Feature: An acceptance feature for the sign-off lifecycle selftest",
        `Feature: An acceptance feature for the sign-off lifecycle selftest (${relativePath})`,
      );
      await writeFile(path.join(tempDir, relativePath), named);
    }

    await gitInit(tempDir);

    // One `nuka run` invocation, over the directory both features sit in,
    // is what makes them green together under a single run_id -- the
    // report this scenario reproduces (a green run of two features, then
    // dirty-tree refused on the second accept) never happens with two
    // separate `nuka run` calls.
    const runResult = await runNuka(["run", "acceptance/"], tempDir);
    if (runResult.exitCode !== 0) {
      throw new Error(`expected one run over both acceptance features to exit 0, got ${runResult.exitCode}: ${runResult.stdout}`);
    }

    currentTwoFeature = { tempDir, featureRelativePaths, acceptResults: [] };
  },
);

When("each of them is accepted in turn", { timeout: 30_000 }, async function () {
  const state = requireCurrentTwoFeature();
  for (const featureRelativePath of state.featureRelativePaths) {
    const result = await runNuka(["accept", featureRelativePath], state.tempDir);
    state.acceptResults.push(result);
  }
});

Then("both records exist and neither accept asked for the run to be repeated", async function () {
  const state = requireCurrentTwoFeature();
  if (state.acceptResults.length !== state.featureRelativePaths.length) {
    throw new Error(`expected ${state.featureRelativePaths.length} accept results, got ${state.acceptResults.length}`);
  }

  const recordPaths: string[] = [];
  for (const [index, result] of state.acceptResults.entries()) {
    // Exit 0 is exactly the proof this scenario needs: every refusal that
    // would send someone back to `nuka run` again (dirty tree, HEAD
    // moved, no qualifying run) exits 1 -- a repeated run was asked for if
    // and only if one of these two accepts failed.
    if (result.exitCode !== 0) {
      throw new Error(
        `expected accepting ${state.featureRelativePaths[index]} to succeed without needing the run repeated, got exit ${result.exitCode}: ${result.stdout} ${result.stderr}`,
      );
    }
    const recordPath = result.stdout.trim();
    if (!recordPath.endsWith(".md")) {
      throw new Error(`expected accept's own stdout to be a record path ending in .md, got: ${JSON.stringify(result.stdout)}`);
    }
    recordPaths.push(recordPath);
  }

  if (new Set(recordPaths).size !== recordPaths.length) {
    throw new Error(`expected each accept to write its own record, got the same path twice: ${JSON.stringify(recordPaths)}`);
  }

  for (const recordPath of recordPaths) {
    try {
      await readFile(path.join(state.tempDir, recordPath), "utf8");
    } catch {
      throw new Error(`expected ${recordPath} to exist on disk after accept`);
    }
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
  if (currentTwoFeature !== null) {
    await rm(currentTwoFeature.tempDir, { recursive: true, force: true });
    currentTwoFeature = null;
  }
});
