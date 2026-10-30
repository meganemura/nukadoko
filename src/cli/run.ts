import type { ChildProcess } from "node:child_process";
import { readdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { PickleStepType } from "@cucumber/messages";
import { analyzeRunSelectionKeepingSteps } from "../check/analyze.js";
import { checkBindings } from "../check/binding-check.js";
import { declaresDoneCallback, RUN_HOOK_ARG_COUNT } from "../check/done-callback.js";
import { matchPickleStepText } from "../check/feature-check.js";
import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig } from "../config/load-config.js";
import { loadProgram, PROGRAM_FILE_NAME } from "../config/load-program.js";
import type { Program, ProgramRecipe } from "../config/program-schema.js";
import { namesPlaceholder, placeholderRefusal } from "../program/placeholders.js";
import { createWorldStarter, type StartedWorld, type WorldStep } from "../program/world.js";
import { applyWorldEnv } from "../program/world-view.js";
import { loadEnvFiles } from "../context/env.js";
import { createRequestScreenWarner, createTraceVersionWarner } from "../context/trace-actions.js";
import { discoverSteps, type DiscoveryResult } from "../discover/discover-steps.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  defaultEnvironmentNames,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { hookDisplayTitle } from "../record/scenario-record.js";
import { buildStepBindings, type StepBinding } from "../run/match-step.js";
import { probeGitState } from "../run/probe-git.js";
import { runConcurrentPickles } from "../run/run-concurrent.js";
import {
  createStepProgressLogger,
  type FailedScenario,
  failedScenarioFindings,
  failedScenarioOf,
  writeOutputLocations,
  writeRunSummary,
  writeScenarioBoundary,
  writeProofRunBoundary,
  writeCriteriaCounts,
  writeControlCounts,
  writeRepeatTallies,
  createRepeatTally,
  formatRerunCommand,
  type ControlCounts,
  type CriteriaCounts,
  type RunConditions,
} from "../run/progress-log.js";
import { buildTable, executionOutcome, foldCell, foldHeadCell, hasRequiredCell, judgedRowFindings, leftOutText, needsProofRun, plannedWorldCells, rolesOf, rowsWithoutRequiredCell, type ExecutionOutcome, type TableEnvironment } from "../run/verdict-table.js";
import { readCriterionTags, roleIn, type CellRole } from "../condition/condition.js";
import type { FlagEvaluation, ServedRequest } from "../execution-events/format.js";
import type { ListedPlaces } from "../execution-events/lists.js";
import { flagRows } from "../run/flag-rows.js";
import { comparePaths } from "../run/path-view.js";
import { routeRows } from "../run/route-rows.js";
import { BaseSetupError, criterionKey, GitRefError, oldPlaces, prepareBase, projectRelativeText, resolveRef, type PreparedBase } from "../run/base-run.js";
import { runTreePass, stopTreeWorkers, type TreeTarget } from "../run/tree-pass.js";
import type { SecretSet } from "../secrets/types.js";
import { shellWord } from "../shell/shell-word.js";
import { exitCodeForSignal, installProcessSignalHandlers, runOnce, type ProcessSignal } from "../run/process-signal.js";
import { openWalk, restartCommand, type WalkHandle } from "../run/walk-files.js";
import { generateRunId } from "../run/run-id.js";
import { findRepeatedScenarioPrefixes } from "../run/repeated-prefix.js";
import { renderRunSummary, writeRunSummaryFiles } from "../run/run-summary.js";
import { buildRunScenario, gherkinStepLines, pickleStepLines } from "../run/run-document.js";
import { judgedEarlyFindings, readingsToRecount, withAfterWorldStop } from "../run/events-after-stop.js";
import { RUN_FILE_DIRS, relativeToRun, runRelativeDir, stepRecordRelativeDir } from "../record/state-layout.js";
import { readStepRecordsForScenario } from "../report/step-records.js";
import { readOwnVersion } from "../version.js";
import { writeRunSources } from "../record/run-sources.js";
import { resolveProjectName } from "../report/allure/identity.js";
import {
  countScenarios,
  RED_VERDICTS,
  runResultRelativePath,
  writeRunResult,
  type RunFields,
  type RunScenario,
  type RunWorld,
  type RunWorldName,
} from "../record/run-result.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import { applyRetention, formatRetention } from "../record/retention.js";
import {
  doneCallbackMessage,
  pendingOrSkippedMessage,
  runScenario,
  runWithTimeout,
} from "../run/run-scenario.js";
import { DirectoryTargetLineError, parseFeatureTarget, selectPickles } from "../run/select-pickles.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { fixtureTeardownWarning, redact, redactString, versionProbeWarning } from "../secrets/redact.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../fixture/validate-fixtures.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import { isClaimStep } from "../step/define-step.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { asFinding, writeCheckIssueLines } from "./check.js";
import { formatFinding, warningSink, type Finding } from "../finding/finding.js";
import { checkCodeFix } from "../check/codes.js";
import type { RefusalCode } from "./refusal-codes.js";
import { FAILED_EXIT_CODE, REFUSED_EXIT_CODE, RefusalError, formatEnvelope, refusalOf, withHint, writeStopped, type Hint } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { finalizeOpenRequests, installChannelPatches } from "../context/create-context.js";

// Responsibility: `nuka run`'s work, kept out of run-cli.ts so it is
// unit-testable without going through yargs (same split as cli/do.ts).
// Two phases, matching docs/spec.md's "Running"/"Records" split:
//
//   1. Setup. A malformed feature target (missing file, invalid `:line`,
//      a parse failure: src/run/select-pickles.ts), a config or discovery
//      error, or an unknown `--env` name. None of these write anything: the
//      run never started, so there is nothing to attest to. An error
//      `nuka check` reports for the selected scenarios is a setup failure
//      too (src/check/analyze.ts's `analyzeRunSelectionKeepingSteps`),
//      unless `--no-check` skips that check: a scenario that can only fail
//      is not worth a browser and minutes. The check's discovery is the one
//      the run executes, so a step file is imported once either way.
//   2. Execution. From the first pickle onward, every pickle that begins
//      executing gets a scenario record no matter what happens inside it
//      (src/run/run-scenario.ts). Every scenario starts with no browser
//      state: one that needs login state gets it from a fixture or a Given
//      step its feature names.
//
// Computed once, at the top of the execution phase, and shared by every
// scenario and step record in the run: the version probe, `ctx.env`, the
// SecretSet, `runId` (src/run/run-id.ts), and `git` (src/run/probe-git.ts).
// The set is built before the probe's warning is written. That warning is
// the probe function's own text and can carry a value loaded from an
// untracked env file, and it goes to stderr, not into a scenario record.
// `resolvedEnv.policy` is passed into every `runScenario` call.
// src/run/run-scenario.ts owns the refusal and the backstop, because both
// need a per-step, per-position view this module does not have.
//
// `registerAllureRuntime()` runs once, at the top of the execution phase,
// never in setup: a setup failure writes nothing, so there is no pickle for
// it to matter to yet. Its restore callback runs in that phase's own
// `finally`, nested inside the outer `finally` that stops the signal
// handlers. Every pickle shares that one registered `TestRuntime`. src/run/run-scenario.ts repoints which
// collector is active per pickle and per step or hook boundary.
//
// Each pickle carries its own feature's `gherkinDocument`
// (`SelectedFeature.gherkinDocument`, src/run/select-pickles.ts) into
// `runScenario`. A directory target spans more than one file, so each
// pickle carries the document of the file it came from, via the
// `{ feature, pickle }` pairs `flatPickles` builds.
//
// `buildStepBindings` receives `compatParameterTypes`. `discoverSteps`'s
// `instantiateCompatWorld` and `compatHooks` are threaded into every
// `runScenario` call. Every registered hook's tag expression, if any, is
// validated once in the setup phase, before any pickle runs. An unsupported
// tag expression is unsupported for the whole invocation, not for one
// pickle, so discovering it only when a matching pickle is selected would
// make a project-wide failure look scenario-dependent.
//
// BeforeAll and AfterAll run here, not in src/run/run-scenario.ts. They
// belong to this whole `nuka run` invocation, not to any one pickle, the
// same reason `registerAllureRuntime` is called once here. They sit
// immediately around the pickle loop, after every setup-phase failure path
// has already returned, and they are skipped when `flatPickles` is empty:
// a run that executes nothing has nothing for them to prepare or tear down.
// `BeforeAll` failing skips the pickle loop, and `AfterAll` is still
// attempted (the same Before/After asymmetry src/run/run-scenario.ts uses,
// one level up). Neither has a record of its own. These hooks report
// through stderr and this function's exit code, the same channel setup
// failures already use. `runWithTimeout`, `doneCallbackMessage`, and
// `pendingOrSkippedMessage` come from src/run/run-scenario.ts rather than
// being copied here.
//
// `from`'s structural validation (`validateStepFrom` in
// src/step/validate-from.ts) is a setup-phase fatal: stderr and exit 1, no
// scenario written. It runs once for the invocation right after `bindings`
// builds, never once per pickle. It is scoped to the step names this run's
// selected pickles resolve to (`usedStepNames`, via the same
// `checkBindings` and `matchPickleStepText` seam src/check/from-order.ts
// reuses), not the whole vocabulary. A broken `from` on a step this
// invocation never binds is not this invocation's refusal. `nuka check` is
// where a project-wide finding belongs. The scenario-order guard
// (docs/spec.md "Chaining steps") is a separate check, once per pickle,
// inside src/run/run-scenario.ts, because it needs that pickle's own step
// order.
//
// A `:line` target that selects fewer scenarios than its file holds makes
// the run `selection: partial`, in run.json and in the summary's header,
// so a summary pasted onto a pull request is not read as the whole
// feature (docs/spec.md "Scenarios (the scripted path)"). The summary is
// where that reader looks; a stderr line would say it only to the person
// who already chose the line.
//
// Progress lines (src/run/progress-log.ts) go to stderr, never stdout.
// stdout's one-JSON-record-per-scenario contract stays a machine contract.
// `onStepEnd` is built once and threaded into every `runScenario`
// call. The progress has no TTY check. A CI log wants the same progress. The records
// on stdout are written only under `--records`, and under `--json` none of
// these lines is written at all (see `runRun`).
//
// The Markdown run summary (src/run/run-summary.ts) is the reader-facing
// counterpart of those stderr lines. Every written record is noted as it is
// written, by this file at concurrency 1 and through `onRecord` above it,
// and the summary is written once, after AfterAll and process fixture
// teardown, so its verdict is the exit code's. It is written before the
// output locations so that list can name it, and after run.json, so a
// run.json that could not be written is in the summary as the failure it
// is.
//
// Each environment's pass runs against one world (src/program/world.ts):
// when the tree has a program file, the world is built, prepared, and
// served before the pass's BeforeAll, and stopped after its process
// fixtures are torn down, since a fixture's teardown may still talk to
// it. A world that does not start fails the pass, and its scenarios are
// cells that did not run. The world's env is set on this process for the
// pass, so a step and every child it starts read it as the program does,
// and run.json names each world (`worlds`).
//
// `--concurrency` above 1 diverts to src/run/run-concurrent.ts, in one
// branch after every setup-phase check (bindings, from, fixtures, tag
// expressions) and before `registerAllureRuntime`. Those checks still run
// once, project-wide, so a higher concurrency refuses the same broken
// project concurrency 1 would, before spawning a worker. A target that
// names one feature file drops concurrency back to 1 instead of refusing
// (the comment above that branch says why). From there, the execution-phase code below is what a concurrency-1
// run always takes.
//
// `--base <ref>` adds the base and the old world (docs/spec.md "Verdicts").
// The ref is resolved before the config loads, so a ref that names nothing,
// or a shallow clone that lacks it, is refused before anything runs. The
// comparison and the trees are made once the run has an id and before
// head's pass (src/run/base-run.ts), so the trees hold head's working tree
// as the run found it. After head's pass, its proof runs included, each
// row's head cells decide which base and old cells it needs
// (src/run/verdict-table.ts's `plannedWorldCells`), and each tree runs
// them, one environment at a time, against a world built from that tree
// (src/run/tree-pass.ts). Their records are run.json entries with
// `world`, keyed to the head row they are a cell of, and the trees are
// removed before run.json is written. Where both program files name
// `{events}`, the base world also runs, once and for run.json's `paths`
// alone, each row whose head cell is required and ran and that no base
// cell runs, so a criterion that did not change still shows what the code
// change did to its path. Such an entry carries `for_paths` and is no
// cell, so the table, the proof runs, and the verdicts never read it.

/** The `nuka check` codes that mean a step's pattern did not build at all
 * (src/check/binding-check.ts's own classification of a pattern error, plus
 * an invalid `config.parameterTypes` entry, which leaves no registry to
 * build any pattern against). A pattern that did not build matches nothing,
 * which is what the pre-run warning below is about; every other binding
 * issue leaves a pattern that still matches. */
const UNBUILDABLE_PATTERN_CODES: ReadonlySet<string> = new Set([
  "unnamed-capture",
  "invalid-capture-key",
  "unterminated-capture",
  "unknown-parameter-type",
  "pattern-syntax-error",
  "pattern-error",
  "parameter-type-invalid",
]);

// One environment a run executes under: what `--env <name>` resolves to,
// and what follows from it before the first scenario runs.
interface EnvironmentPass {
  readonly resolvedEnv: ResolvedEnvironment;
  /** The name a worker resolves, or null for the implicit `default` a run
   * with no `--env` falls back to. */
  readonly envArg: string | null;
  readonly envVars: Readonly<Record<string, string>>;
  readonly secrets: SecretSet;
  readonly targetVersion: string | undefined;
}

export interface RunRunOptions {
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  notices?: readonly Finding[];
  rootDir: string;
  /** `<feature[:line]>` or directory targets. None means `featuresDir`,
   * the same default `nuka check` walks (without `additionalFeatureDirs`,
   * which only `nuka check` reads). */
  featureArgs: readonly string[];
  /** `false` under `--no-check`: skip the static check this run otherwise
   * performs over its own selection before it executes anything. */
  check: boolean;
  /** `--env`, in the order given. Empty selects the environments that
   * declare conditions, or `default` when none does
   * (src/environment/resolve-environment.ts's `defaultEnvironmentNames`).
   * Each selected scenario runs once per environment, in this order. */
  envs: readonly string[];
  /** `--records`: write each scenario's run.json entry to stdout, one per
   * line, as the scenario finishes. The line is not held back for a
   * step's `program_log_late`, which the world's stop adds to run.json
   * later: a consumer of the stream gets each scenario when it ends.
   * Without it stdout stays empty, terminal or not. */
  records: boolean;
  /** `--json`: print run.json on stdout at the end, and no scenario
   * entry stream, so stdout holds exactly one JSON document. */
  json: boolean;
  /** `--concurrency`'s raw value; default 1 (cli/run-cli.ts's own `??`). At
   * 1, every other paragraph in this file's own header describes what
   * happens — the branch near this function's own `restoreAllureRuntime`
   * call is the only place a value above 1 changes anything (docs/spec.md
   * "Scenarios (the scripted path)"). */
  concurrency: number;
  /** `--repeat`'s raw value; default 1. Above 1, every selected scenario
   * runs that many times in this one invocation, whole selection first
   * and then again, each execution its own scenario record under the one
   * run_id. Exists for a failure that reproduces one time in several: the
   * alternative is a shell loop of `nuka run`, which spreads the evidence
   * over that many run ids, and the run summary reads one.
   * Under `--concurrency`, each worker repeats its own files; a target
   * naming one file still runs at 1 (docs/spec.md "Scenarios"). */
  repeat: number;
  /** `--proof-runs`'s raw value; default 2. A control cell whose Then
   * failed runs again until it has broken the same claim at the same line
   * this many times, or a run disagrees (src/run/verdict-table.ts). */
  proofRuns: number;
  /** `--base <ref>`: compare each criterion with the commit `ref` names,
   * and run the base and the old world for the rows that need them.
   * `undefined` without it. */
  base?: string;
  /** `--step`: walk one execution of one scenario, pausing after each
   * step until `nuka step` answers (src/run/walk-files.ts). */
  step?: boolean;
  /** `$GITHUB_STEP_SUMMARY` as the CLI read it, `undefined` when unset or
   * empty. Passed in rather than read here so a test decides it. */
  stepSummaryPath: string | undefined;
  stdout: WritableSink;
  stderr: WritableSink;
  /** Redacts these secrets from what project code prints on the process
   * stdout and stderr, a worker's lines the parent relays included;
   * absent when the streams are not the process's. */
  redactProjectOutput?: (secrets: SecretSet) => void;
}

/** Whether a world of this recipe writes execution events: nukadoko
 * serves it, and its program file names {events} (src/program/world.ts). */
function writesEvents(recipe: ProgramRecipe | null): boolean {
  return recipe !== null && recipe.reach.kind === "serve" && namesPlaceholder(recipe, "events");
}

/** What an execution the base ran for paths alone came to, in a cell's
 * words, since no cell holds it. */
function forPathsOf(execution: RunScenario, inThen: (index: number) => boolean): NonNullable<RunScenario["for_paths"]> {
  const { outcome, line } = foldCell([executionOutcome(execution, inThen)]);
  return { outcome, ...(line === undefined ? {} : { line }) };
}

/** The step records row, when the run wrote a scenario. Scenarios have no
 * directory of their own to name: run.json holds them. */
function stepsLocation(
  rootDir: string,
  stateDir: string,
  runId: string,
  scenariosWritten: number,
): Array<{ label: string; relativePath: string; kind: "dir" | "file"; count?: number }> {
  const relativePath = path.join(runRelativeDir(stateDir, runId), RUN_FILE_DIRS.steps);
  return [...(scenariosWritten > 0 ? [{ label: "steps", relativePath, kind: "dir" as const, count: stepRecordsIn(path.join(rootDir, relativePath)) }] : [])];
}

// The step records the directory holds, read from it: a tree world's
// worker writes its records there too, so a tally of head's passes alone
// would print a count of a directory that holds more.
function stepRecordsIn(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** The `nuka check` that reports the errors a run stopped over, as check
 * accepts it: check reads whole files and refuses a `:line` target, so
 * each targeted file is named once, without its line. */
export function checkCommandFor(targets: readonly string[], envs: readonly string[]): string {
  const files = [...new Set(targets.map((target) => parseFeatureTarget(target).relativePath))];
  return ["nuka check", ...files.map(shellWord), ...envs.flatMap((name) => ["--env", shellWord(name)])].join(" ");
}

/** Why a run selected no scenario. When `--env` left every scenario out,
 * the fix says what a run without `--env` selects in this project, and
 * the `do:` line is that run only when those environments meet every
 * targeted scenario, since `nuka check` refuses one they do not
 * (`condition-unmet`). Otherwise it names the first environment of the
 * program file that meets every scenario, or else one that meets some,
 * and there is none when no environment meets any. When the targets hold
 * no scenario, only an edit gets past it. Pure. */
export function nothingSelectedFinding(
  targets: readonly string[],
  givenTargets: readonly string[],
  envs: readonly string[],
  leftOutTags: readonly (readonly string[])[],
  program: Pick<Program, "environments" | "defaultEnvironments"> | null,
  programFile: string,
): Finding {
  const leftOut = leftOutTags.length;
  if (leftOut === 0) {
    return {
      severity: "failed",
      code: "nothing-selected",
      message: `no scenario to run in ${targets.join(", ")}, so nothing was checked`,
      fix: "Add a scenario to the feature files the targets name, or name a target that holds one.",
    };
  }
  const environments = program?.environments ?? {};
  const tableEnvironment = (name: string): TableEnvironment => ({ name, conditions: Object.hasOwn(environments, name) ? environments[name]?.conditions : undefined });
  const meetsEach = (names: readonly string[]): boolean => leftOutTags.every((tags) => hasRequiredCell(tags, names.map(tableEnvironment)));
  const meetsAny = (name: string): boolean => leftOutTags.some((tags) => hasRequiredCell(tags, [tableEnvironment(name)]));
  const defaults = defaultEnvironmentNames(program);
  const chosenBy =
    program?.defaultEnvironments !== undefined
      ? `defaultEnvironments in ${programFile}`
      : defaults[0] === DEFAULT_ENVIRONMENT_NAME
        ? "no environment declares conditions"
        : "the environments that declare conditions";
  const without = `A run without --env selects ${defaults.join(", ")} (${chosenBy})`;
  const run = (env: readonly string[]): string => ["nuka run", ...givenTargets.map(shellWord), ...env.map(shellWord)].join(" ");
  const message = `no scenario to run: the conditions of the ${leftOut} selected ${leftOut === 1 ? "scenario" : "scenarios"} hold in no environment --env names (${envs.join(", ")}), so nothing was checked`;
  const them = leftOut === 1 ? "it" : "them";
  if (meetsEach(defaults)) {
    return { severity: "failed", code: "nothing-selected", message, fix: `${without}, which meets ${them}.`, do: run([]) };
  }
  const candidates = [...Object.keys(environments), ...(Object.hasOwn(environments, DEFAULT_ENVIRONMENT_NAME) ? [] : [DEFAULT_ENVIRONMENT_NAME])].filter((name) => !envs.includes(name));
  const other = candidates.find((name) => meetsEach([name])) ?? candidates.find(meetsAny);
  if (other === undefined) {
    return {
      severity: "failed",
      code: "nothing-selected",
      message,
      fix: `${without}, which does not meet ${them} either, and no environment of ${programFile} meets ${them}. Declare the conditions ${leftOut === 1 ? "it needs" : "they need"} on an environment, or change ${leftOut === 1 ? "its" : "their"} tags.`,
    };
  }
  return {
    severity: "failed",
    code: "nothing-selected",
    message,
    fix: `${without}, which does not meet ${them} either. ${other} meets ${meetsEach([other]) ? them : "some of them"}.`,
    do: run(["--env", other]),
  };
}

export async function runRun(options: RunRunOptions): Promise<number> {
  const { rootDir, concurrency, repeat, stepSummaryPath, stderr } = options;
  const notices = options.notices ?? [];
  // Under `--step`, the walk this run records. Every way the run stops
  // before its scenario runs ends it as not run, with what the run printed,
  // so a `nuka step` waiting for it reports the reason, not a timeout.
  let walk: WalkHandle | undefined;
  const stopRun = (findings: readonly Finding[], exitCode: number): number => {
    walk?.end({ how: "not-run", exit_code: exitCode, findings });
    return writeStopped({ json: options.json, stdout: options.stdout, stderr, command: "run" }, findings, exitCode);
  };
  const refused = (error: unknown, code: RefusalCode = "unexpected-error", hint?: Hint, before: readonly Finding[] = []): number =>
    stopRun([...notices, ...before, refusalOf(error, code, "run", hint)], REFUSED_EXIT_CODE);
  // The records are on disk, and the `run` line names run.json. An
  // agent's shell is no terminal and reads stdout together with stderr, so
  // a stream that was on by default would put a line of JSON per scenario
  // between its progress lines. A reader that wants the stream asks for it.
  const stdout: WritableSink = !options.json && options.records ? options.stdout : { write: () => true };
  // What a person watches the run by: progress, where it wrote, the count,
  // the failed and rerun lines, and notices about the selection. Under
  // `--json` the document holds the result, and an agent's shell reads both
  // streams as one, so these lines would sit around the document. A warning
  // about something that went wrong still goes to `stderr`.
  const progress: WritableSink = options.json ? { write: () => true } : stderr;
  // Every warning and failure is a finding. Text writes it to stderr when
  // it happens; `--json` keeps it for the one document, so stderr stays
  // empty and the document says everything the run found.
  const runFindings: Finding[] = [...notices];
  // The secrets the process stderr is redacted with (step-stdout.ts). A
  // finding can quote what project code printed, such as a line a worker
  // wrote on its stdout, so run.json and the summary redact it with the
  // same set and read as stderr did.
  let printedSecrets: SecretSet = [];
  const redactOutput = (secrets: SecretSet): void => {
    printedSecrets = [...printedSecrets, ...secrets];
    options.redactProjectOutput?.(secrets);
  };
  const warn = (raw: Finding): void => {
    const finding = printedSecrets.length === 0 ? raw : (redact(raw, printedSecrets) as Finding);
    runFindings.push(finding);
    if (!options.json) stderr.write(formatFinding(withHint(finding)));
  };
  const warnings = (code: string): WritableSink => warningSink(code, warn);

  // yargs' own `type: "number"` (cli/run-cli.ts) turns an unparseable
  // `--concurrency` value into `NaN` rather than refusing it, and accepts a
  // fraction like `2.5` without complaint either way — neither is a setup
  // failure yargs itself can catch, so both are refused here, in the same
  // "any failure here writes nothing" phase every other setup check below
  // already belongs to.
  if (!Number.isInteger(repeat) || repeat < 1) {
    return refused(`--repeat must be a whole number of 1 or more (got ${options.repeat}).`, "invalid-value");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return refused(`--concurrency must be a whole number of 1 or more (got ${options.concurrency}).`, "invalid-value");
  }
  const { proofRuns } = options;
  if (!Number.isInteger(proofRuns) || proofRuns < 1) {
    return refused(`--proof-runs must be a whole number of 1 or more (got ${options.proofRuns}).`, "invalid-value");
  }
  // Resolved once, before anything runs: a ref that names nothing, or a
  // project outside git, has nothing to compare against, and a run that
  // judged every row `new` would claim a comparison it did not make. A
  // shallow clone that lacks the ref is told how to fetch it.
  let baseRef: { ref: string; commit: string } | undefined;
  // A walk refuses --base once it is recorded, below: nothing to resolve.
  if (options.base !== undefined && options.step !== true) {
    const resolved = await resolveRef(rootDir, options.base);
    if ("problem" in resolved) {
      if (resolved.problem === "outside-git") return refused(resolved.message, "base-outside-git");
      if (resolved.problem === "git-failed") return refused(projectRelativeText(resolved.message, rootDir), "base-git-failed");
      if (resolved.problem === "shallow") return refused(resolved.message, "base-shallow", resolved.fetch === undefined ? undefined : { do: resolved.fetch });
      return refused(resolved.message, "base-ref-unknown", { do: "git log --oneline" });
    }
    baseRef = { ref: options.base, commit: resolved.commit };
  }

  // This whole invocation's own start — read
  // again just before the summary line is written, near this function's own
  // `return`, so that line's own elapsed time covers the whole invocation
  // (config load and discovery included), not just the pickle loop.
  const invocationStartedAt = new Date();

  // Before the config and the step files load: a module that copies
  // `fetch` or `http.request` while it loads keeps whatever it copied, and
  // the channel patches (src/context/channels.ts) see only calls that go
  // through them.
  installChannelPatches();

  // --- Setup phase: any failure here writes nothing. ---
  let config;
  let program;
  let programFile = PROGRAM_FILE_NAME;
  try {
    config = await loadConfig(rootDir);
    const loaded = await loadProgram(rootDir);
    program = loaded?.program ?? null;
    programFile = loaded?.fileName ?? programFile;
  } catch (error) {
    return refused(error);
  }
  const featureArgs = options.featureArgs.length === 0 ? [config.featuresDir] : options.featureArgs;
  // Recorded as soon as the state directory is known, so a refusal from
  // here on reaches a `nuka step` waiting for this walk.
  const walkTarget = [...featureArgs, ...options.envs.flatMap((name) => ["--env", name])].map(shellWord).join(" ");
  if (options.step === true) {
    const opened = openWalk({
      rootDir,
      stateDir: config.stateDir,
      target: walkTarget,
      ...(options.json ? {} : { announce: (text: string) => stderr.write(text) }),
    });
    if ("refused" in opened) return refused(opened.message, "walk-in-progress", { do: "nuka step wait" });
    walk = opened;
  }
  // Without `--env`, the environments that declare conditions, since the
  // scenarios name the conditions they need; `default` when none does.
  const envs = options.envs.length > 0 ? options.envs : defaultEnvironmentNames(program);
  // Only the implicit `default` goes without a name on a rerun line or to
  // a worker: every other environment, chosen or not, is named.
  const implicitDefault = options.envs.length === 0 && envs.length === 1 && envs[0] === DEFAULT_ENVIRONMENT_NAME;

  // One environment twice would run every scenario twice under the same
  // name, and its cells could not be told apart.
  const repeated = envs.filter((name, index) => envs.indexOf(name) !== index);
  if (repeated.length > 0) {
    return refused(`--env names ${[...new Set(repeated)].map((name) => `"${name}"`).join(", ")} more than once`, "invalid-value");
  }
  // A rerun line has to land in the same environment the failure came from.
  // A run that ran only the implicit `default` names none, since a rerun
  // without `--env` runs there again.
  const conditionsOf: RunConditions = {
    rerunFlags: (environment) => (implicitDefault ? [] : ["--env", environment]),
    named: envs.length > 1,
  };
  const rerunFlags = options.envs.flatMap((name) => ["--env", name]);

  let resolvedEnvs: ResolvedEnvironment[];
  try {
    resolvedEnvs = envs.map((name) => resolveEnvironment(config, program, name, !implicitDefault));
  } catch (error) {
    return refused(error);
  }

  // Installed for the serial execution path, once that path's process
  // cache exists, and under `--base` before the trees are made, which a
  // signal must remove. A signal before either still takes the default
  // action: nothing has been built. `stop()` in the `finally` below
  // removes it on a normal return.
  let processSignal: ProcessSignal | undefined;
  // The trees of `--base`, removed on every way out of the run.
  let prepared: PreparedBase | undefined;
  try {
    if (walk !== undefined) {
      // A walk waits on a person between steps, and a signal is what ends a
      // pause nobody answers. Installed now, so a signal at any point of
      // the walk tears down what ran and records the walk as interrupted.
      const recorded = walk;
      processSignal = installProcessSignalHandlers();
      processSignal.setExitRecord((signal, exitCode) => recorded.end({ how: "interrupted", exit_code: exitCode, signal }));
      if (repeat > 1 || options.base !== undefined) {
        return refused(
          `nuka run --step walks one execution of one scenario, and ${repeat > 1 ? `--repeat ${repeat} runs it ${repeat} times` : "--base runs it in more than one world"}`,
          "step-needs-one-scenario",
          { do: restartCommand(walkTarget) },
        );
      }
    }
    const select = (): ReturnType<typeof selectPickles> | { refused: unknown } => {
      try {
        return selectPickles(rootDir, featureArgs);
      } catch (error) {
        if (error instanceof DirectoryTargetLineError) {
          const command = ["nuka", "run", ...error.targetsWithoutLine, ...rerunFlags].map(shellWord).join(" ");
          return { refused: new RefusalError("line-on-directory", error.message, { do: command }) };
        }
        return { refused: error };
      }
    };

    // The static check runs before execution, so a step file that fails to
    // import is reported the way `nuka check` reports it, grouped and with
    // its line, rather than as the first import error discovery happens to
    // throw. It needs the selection first, and its discovery is the one
    // this run executes, so every step file is imported once. Under
    // `--no-check`, discovery keeps its place ahead of selection.
    let selected: ReturnType<typeof selectPickles> | null = null;
    let discovery: DiscoveryResult;
    if (options.check) {
      const selection = select();
      if ("refused" in selection) return refused(selection.refused);
      selected = selection;
      let analysis;
      try {
        // The names --env gave, not the selection they resolve to: the check
        // reports condition-unmet for the default selection alone.
        analysis = await analyzeRunSelectionKeepingSteps(rootDir, selected.features, options.envs);
      } catch (error) {
        return refused(error);
      }
      const { report } = analysis;
      if (report.errors.length > 0) {
        // The errors print in check's grammar ahead of the refusal; in
        // text the import-failure fold applies, as `nuka check` prints it.
        if (!options.json) writeCheckIssueLines(report.errors, [], stderr);
        const count = report.errors.length;
        return refused(
          `nuka run did not start: nuka check reports ${count} ${count === 1 ? "error" : "errors"} for these scenarios`,
          "check-errors",
          {
            fix: "Correct each error the findings name, or pass --no-check to run anyway.",
            do: checkCommandFor(options.featureArgs, options.envs),
          },
          options.json ? report.errors.map((issue) => asFinding("error", issue)) : [],
        );
      }
      discovery = analysis.discovery;
    } else {
      try {
        discovery = await discoverSteps(rootDir, config.featuresDir);
      } catch (error) {
        return refused(error);
      }
    }
    const { vocabulary, compatParameterTypes, instantiateCompatWorld, compatHooks, compatRunHooks, defaultTimeoutMs } =
      discovery;

    // Every registered hook's own tag expression is validated here — a
    // setup failure, same family as the parameterTypes collision
    // below, not attributable to any one pickle.
    try {
      for (const hook of compatHooks) {
        if (hook.tags !== undefined) {
          validateTagExpression(hook.tags);
        }
      }
    } catch (error) {
      return refused(error);
    }

    if (selected === null) {
      const selection = select();
      if ("refused" in selection) return refused(selection.refused);
      selected = selection;
    }

    // Flattened once, here, into the `{ feature, pickle }` pairs every use
    // below actually needs: `selected.features` stays grouped by file for
    // sources.json, but every other use (counting,
    // the from/fixture checks, the pickle loop itself) wants one ordered
    // sequence across every file, each pickle still paired with *its own*
    // feature's `relativePath`/`gherkinDocument`, never a stray shared one.
    const targetedPickles = selected.features.flatMap((feature) =>
      feature.pickles.map((pickle) => ({ feature, pickle })),
    );

    // A `:line` target that leaves out other scenarios of its file makes
    // the run cover less than the files it names. run.json says so, and the
    // summary says so in its header, so a summary is not read as the whole
    // feature. `:line` on a directory target is refused in setup, so a
    // non-null line here always names one file.
    const lineTargets = featureArgs.filter((featureArg) => parseFeatureTarget(featureArg).line !== null);
    const selection: RunFields["selection"] =
      lineTargets.length > 0 && targetedPickles.length < selected.totalPickles ? "partial" : "full";

    // Under `--env`, a criterion no named environment meets would have
    // only control cells, and nothing it showed would count. It is not
    // run, and the table and the summary count it, so naming one
    // environment runs what applies there: a hook failure's `do:` line,
    // which names one, runs as printed. Without `--env` the program file
    // chose the environments and is expected to cover every condition a tag
    // names, so `nuka check` reports such a criterion (`condition-unmet`)
    // and a run under `--no-check` keeps its red row. Workers select by
    // the same `selected`, so a file keeps only the lines that run.
    const tableEnvironments = resolvedEnvs.map((resolvedEnv) => ({ name: resolvedEnv.name, conditions: resolvedEnv.conditions }));
    const runsHere = (pickle: (typeof targetedPickles)[number]["pickle"]): boolean =>
      options.envs.length === 0 || hasRequiredCell(pickle.tags.map((tag) => tag.name), tableEnvironments);
    const flatPickles = targetedPickles.filter(({ pickle }) => runsHere(pickle));
    const leftOut = targetedPickles.length - flatPickles.length;
    const targetedFeatures = selected.features;
    if (leftOut > 0) {
      selected = {
        ...selected,
        features: selected.features.flatMap((feature) => {
          const kept = feature.pickles.filter(runsHere);
          if (kept.length === feature.pickles.length) return [feature];
          return kept.length === 0 ? [] : [{ ...feature, pickles: kept, selectedLines: kept.map((pickle) => pickle.location?.line ?? 0) }];
        }),
      };
    }

    // --- Execution phase: from here, every pickle that begins gets a
    // scenario record written, whatever happens inside it. ---
    // Building bindings is the one exception: it happens once, before any
    // pickle's own record exists, so a config.parameterTypes/compat
    // defineParameterType name collision here (src/binding/registry.ts's
    // ParameterTypeCollisionError) is treated as a setup failure, not a
    // scenario failure — no
    // scenario record is ever written for it.
    let bindings: readonly StepBinding[];
    try {
      bindings = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
    } catch (error) {
      return refused(error);
    }

    // The same check-time patterns `nuka check` builds (this file's own
    // header) — a broken pattern here simply
    // doesn't appear in `patterns` (`checkBindings`'s own issues/warnings are
    // check's report to make, not this setup phase's to fail over; a pattern
    // that fails to build can't match anything either way, so it surfaces as
    // "undefined" exactly like it already does). Built once, shared by
    // `usedStepNames` below and by every pickle's own from-order guard
    // (src/run/run-scenario.ts's `RunScenarioOptions.patterns`).
    const { patterns, issues: bindingIssues } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
    // A pattern that failed to build matches nothing, so every line meant
    // for it reports as undefined below, in the same red an assertion
    // failure gets. The static check above already refuses this, so this
    // line is reached only under `--no-check`, where a reader would
    // otherwise have to tell "not registered" from "does not pass" on
    // their own. A warning rather than a refusal: `--no-check` asked to run
    // anyway. The parent alone
    // says it: a worker rebuilds the same patterns for itself but its own
    // notes would repeat this line once per worker. Only the issues that
    // mean a pattern did not build are said here: `checkBindings` also
    // reports two patterns that normalize to the same text
    // (`duplicate-pattern`), and both of those build, so a line meant for
    // them reports as ambiguous and names both steps on its own.
    for (const issue of bindingIssues) {
      if (!UNBUILDABLE_PATTERN_CODES.has(issue.code)) continue;
      warn({
        severity: "warning",
        code: issue.code,
        message: `${issue.message.replace(/[.\s]*$/, "")}; every line meant for this step reports as undefined`,
        ...(issue.file !== undefined ? { file: issue.file } : {}),
        ...(issue.step !== undefined ? { step: issue.step } : {}),
        fix: checkCodeFix(issue.code),
      });
    }

    // Which typed step names this run's own selected pickles actually
    // resolve to (this file's own header) — undefined/ambiguous lines
    // resolve to nothing here, same as everywhere else this resolution is
    // done; they are none of this guard's business either.
    const usedStepNames = new Set<string>();
    for (const { pickle } of flatPickles) {
      for (const step of pickle.steps) {
        const { stepNames } = matchPickleStepText(step.text, patterns);
        if (stepNames.length === 1) {
          usedStepNames.add(stepNames[0]!);
        }
      }
    }

    const isRegisteredStep = registeredStepPredicate(
      [...vocabulary.values()].flatMap((entry) => (entry.kind === "typed" ? [entry.step] : [])),
    );
    const fromIssues = [...vocabulary.values()].flatMap((entry) =>
      entry.kind === "typed" && usedStepNames.has(entry.name)
        ? validateStepFrom(entry.name, entry.step, isRegisteredStep)
        : [],
    );
    if (fromIssues.length > 0) {
      return refused(formatFromIssues(fromIssues));
    }

    // The fixture-bag counterpart to the `from` structural check just above
    // — same "scenario-independent,
    // scoped to the steps this invocation actually binds to" shape, checked
    // once per step name rather than once per pickle. `knownNames` widens
    // the closed builtin-only set to builtins ∪ `config.fixtures` — the same
    // set `nuka check` validates a step's
    // own usage against (src/check/analyze.ts).
    const fixtureGraph = buildFixtureGraph(config);
    const knownNames = knownFixtureNames(config);
    const fixtureIssues = [...vocabulary.values()].flatMap((entry) =>
      entry.kind === "typed" && usedStepNames.has(entry.name)
        ? validateStepFixtures(entry.name, entry.step, knownNames)
        : [],
    );
    if (fixtureIssues.length > 0) {
      return refused(formatFixtureIssues(fixtureIssues));
    }

    // The `config.fixtures` *definitions* themselves — cycles,
    // `"process"`-scope-depends-on-`"scenario"`-scope, an
    // unowned `page` override, and a fixture that names `call` — the same findings `nuka check`
    // reports, refused here before execution the same way `fixtureIssues`
    // above already is. Unconditional, unlike `fixtureIssues`: these are
    // properties of `config.fixtures` itself, not of any one step's own
    // usage, so they are not scoped to `usedStepNames` — the same
    // "validate the whole config regardless of what this run happens to
    // touch" convention src/check/config-check.ts already follows.
    const fixtureDefinitionIssues = validateFixtureDefinitions(config);
    if (fixtureDefinitionIssues.length > 0) {
      return refused(formatFixtureDefinitionIssues(fixtureDefinitionIssues));
    }

    // A placeholder a world has no value for is refused before any world
    // runs a command, the build a later world shares included, and before
    // an environment's version probe: `nuka check` reports the same gap,
    // and this is the same refusal under `--no-check`.
    const unfilled = placeholderRefusal(
      resolvedEnvs.flatMap((resolvedEnv) => (resolvedEnv.program === null ? [] : [{ name: resolvedEnv.name, recipe: resolvedEnv.program }])),
      programFile,
      program?.environments ?? {},
    );
    if (unfilled !== undefined) return refused(new Error(unfilled.message), "program-placeholder-unfilled", { fix: unfilled.fix });

    // Nothing checked is no pass: an exit 0 here would read as criteria
    // that hold. It follows every refusal of the setup, which says what to
    // fix first, and precedes the env files, the probes, and the worlds:
    // nothing runs, so there is no evidence to write.
    if (flatPickles.length === 0) {
      return stopRun(
        [
          ...notices,
          nothingSelectedFinding(
            featureArgs,
            options.featureArgs,
            options.envs,
            targetedPickles.filter(({ pickle }) => !runsHere(pickle)).map(({ pickle }) => pickle.tags.map((tag) => tag.name)),
            program,
            programFile,
          ),
        ],
        FAILED_EXIT_CODE,
      );
    }

    // A walk is one execution: one scenario, in one environment, where its
    // conditions hold, since a control would run again for its proof.
    // The `do` walks the first scenario, or the first environment, of
    // what was selected; a control has no command that fixes it.
    if (walk !== undefined) {
      const first = flatPickles[0]!;
      const firstTarget = shellWord(`${first.feature.relativePath}:${first.pickle.location?.line ?? 0}`);
      const envFlags = options.envs.flatMap((name) => ["--env", shellWord(name)]);
      const refusal =
        flatPickles.length > 1
          ? { reason: `the targets select ${flatPickles.length} scenarios`, do: restartCommand([firstTarget, ...envFlags].join(" ")) }
          : resolvedEnvs.length > 1
            ? {
                reason: `it runs in ${resolvedEnvs.length} environments (${resolvedEnvs.map((resolvedEnv) => resolvedEnv.name).join(", ")})`,
                do: restartCommand([firstTarget, "--env", shellWord(resolvedEnvs[0]!.name)].join(" ")),
              }
            : rolesOf(first.pickle.tags.map((tag) => tag.name), tableEnvironments)[0] === "control"
              ? { reason: `the scenario's conditions do not hold in ${resolvedEnvs[0]!.name}, so it would run as a control` }
              : undefined;
      if (refusal !== undefined) {
        return refused(
          `nuka run --step walks one execution of one scenario, and ${refusal.reason}`,
          "step-needs-one-scenario",
          refusal.do === undefined ? undefined : { do: refusal.do },
        );
      }
    }

    // Each environment is a pass of its own: its env files, the
    // secrets they hold, its version probe, and the world its pass starts
    // (in the execution phase, below).
    const passes: EnvironmentPass[] = [];
    const readEnvFiles = async (envFiles: readonly string[]): Promise<Pick<EnvironmentPass, "envVars" | "secrets">> => {
      const envVars = loadEnvFiles(rootDir, envFiles);
      const classification = await classifyEnvFiles(rootDir, envFiles);
      return {
        envVars,
        secrets: buildSecretSet(rootDir, {
          secretSourceFiles: classification.secretSource,
          trackedFiles: classification.tracked,
          publicKeys: config.secrets.public,
          redactKeys: config.secrets.redact,
        }),
      };
    };
    for (const resolvedEnv of resolvedEnvs) {
      // An env file that cannot be read is a setup problem, refused like
      // an invalid config under --no-check too: nothing has run yet, and
      // an `error` finding would read as a run that failed.
      let read: Pick<EnvironmentPass, "envVars" | "secrets">;
      try {
        read = await readEnvFiles(resolvedEnv.envFiles);
      } catch (error) {
        return refused(error);
      }
      const { envVars, secrets } = read;
      redactOutput(secrets);
      const probeResult = await probeVersion(resolvedEnv.version);
      let targetVersion: string | undefined;
      if (probeResult !== undefined) {
        if (probeResult.ok) {
          targetVersion = probeResult.version;
        } else {
          warnings("version-probe-failed").write(versionProbeWarning(resolvedEnv.name, probeResult.reason, secrets) + "\n");
        }
      }
      passes.push({
        resolvedEnv,
        envArg: implicitDefault ? null : resolvedEnv.name,
        envVars,
        secrets,
        targetVersion,
      });
    }

    const runId = generateRunId();
    // One starter for the run, so a tree builds once however many
    // environments it serves. A world's directory sits in the run's own,
    // and its record names paths relative to it, as every path in run.json.
    const runDirAbsolute = path.join(rootDir, runRelativeDir(config.stateDir, runId));
    const worldStarter = createWorldStarter({
      rootDir,
      worldDir: (name) => path.join(runDirAbsolute, "worlds", name),
      recordPath: (absolutePath) => path.relative(runDirAbsolute, absolutePath).split(path.sep).join("/"),
      displayPath: (absolutePath) => path.relative(rootDir, absolutePath).split(path.sep).join("/"),
      // A command is filled with absolute paths (`{root}`, `{dir}`), and
      // every path nukadoko prints is relative to the project.
      progress: { write: (chunk: string) => progress.write(projectRelativeText(chunk, rootDir)) },
      lists: true,
    });
    const worlds: RunWorld[] = [];
    // The URL each of head's worlds reached, unredacted, so the base world
    // can tell a `url` function that answers the same for both trees
    // (src/program/world.ts).
    const headUrls = new Map<string, string>();
    // What each of head's worlds read of the program's lists, by
    // environment, for run.json's `flags` and `routes`.
    const listedPlaces = new Map<string, Partial<ListedPlaces>>();
    // Starts the pass's world, or reports why it did not start. `null`
    // when the tree has no program file: the pass runs with no world.
    // A start a signal aborted is no failure of the program's, and the
    // run that follows is incomplete, so it reports nothing here.
    // A list a started world did not read, as a warning: head's routes
    // and flags, and the tables list of a world of any tree.
    const warnListsUnread = (started: StartedWorld): void => {
      const record = started.record();
      const named = record.tree === "head" ? record.name : `${record.name} (${record.tree})`;
      for (const [kind, list] of Object.entries(record.lists ?? {})) {
        if (list.error === null) continue;
        const log = record.log === null ? "" : `; see ${projectRelativeText(path.join(runDirAbsolute, record.log), rootDir)}`;
        warn({ severity: "warning", code: "program-list-unread", message: `world ${named}: the ${kind} list was not read: ${list.error}${log}` });
      }
    };
    const startWorld = async (pass: EnvironmentPass, abort?: AbortSignal): Promise<StartedWorld | "failed" | null> => {
      if (pass.resolvedEnv.program === null) return null;
      const started = await worldStarter.start(pass.resolvedEnv.name, pass.resolvedEnv.program, pass.secrets, abort);
      if (started.ok) {
        redactOutput(started.view.secrets);
        if (started.view.url !== undefined) headUrls.set(pass.resolvedEnv.name, started.view.url);
        listedPlaces.set(pass.resolvedEnv.name, started.lists);
        warnListsUnread(started);
        return started;
      }
      worlds.push(started.record());
      if (!started.aborted) warn({ severity: "failed", code: "program-start-failed", message: started.message });
      return "failed";
    };
    // Stops the pass's world. Every scenario of the pass has its entry by
    // now, so the stop can find each step's lines of the program's log and
    // events that arrived after its record was written, and those entries
    // say so. A claim on a count of execution events is judged again over
    // every line of the producer's trace, and an execution whose claim the
    // whole count judges otherwise is `broke` in its cell
    // (src/run/events-after-stop.ts).
    const stopWorld = async (world: StartedWorld, tree: RunWorldName = "head"): Promise<void> => {
      const name = world.view.name;
      const inWorld = (scenario: RunScenario): boolean => scenario.environment === name && (scenario.world ?? "head") === tree;
      const passIndexes = runScenarios.flatMap((scenario, index) => (inWorld(scenario) ? [index] : []));
      const { places, recounts } = readingsToRecount(passIndexes.map((index) => runScenarios[index]!));
      const steps: WorldStep[] = runScenarios
        .filter(inWorld)
        .flatMap((scenario) =>
          scenario.steps.flatMap((step) => {
            const slice = step.observed?.program_log;
            if (slice === undefined || slice === null || step.record === null) return [];
            const events = step.observed?.events;
            return [
              {
                traceId: slice.trace_id,
                lines: slice.lines,
                stamped: slice.stamped,
                dir: path.join(runDirAbsolute, step.record),
                ...(events === undefined || events === null ? {} : { events }),
              },
            ];
          }),
        );
      const { exitedEarly, late, eventsLate, paths, recounted } = await world.stop(steps, recounts);
      worlds.push(world.record());
      // Read here, where every line of the world has its owner, so a flag
      // or request line that came after its step's record counts too. Both
      // come from the step's path, the one fold of its trace.
      if (paths.size > 0) {
        for (const scenario of runScenarios) {
          if (!inWorld(scenario)) continue;
          const found = scenario.steps.flatMap((step) => {
            const traceId = step.observed?.events?.trace_id;
            const stepPath = traceId === undefined ? undefined : paths.get(traceId);
            return stepPath === undefined ? [] : [stepPath];
          });
          const evaluated = found.flatMap((stepPath) =>
            stepPath.entries.flatMap((entry) => (entry.kind === "flag" ? (entry.gates ?? []).map((gate) => ({ name: entry.name, side: entry.side, gate })) : [])),
          );
          const sent = found.flatMap((stepPath) => stepPath.requests);
          if (evaluated.length > 0) flagEvaluations.set(scenario.scenario_record_id, [...(flagEvaluations.get(scenario.scenario_record_id) ?? []), ...evaluated]);
          if (sent.length > 0) requestsServed.set(scenario.scenario_record_id, [...(requestsServed.get(scenario.scenario_record_id) ?? []), ...sent]);
        }
      }
      if (late.size > 0 || eventsLate.size > 0 || paths.size > 0) {
        for (const [index, scenario] of runScenarios.entries()) {
          if (!inWorld(scenario)) continue;
          runScenarios[index] = {
            ...scenario,
            steps: scenario.steps.map((step) => {
              const traceId = step.observed?.program_log?.trace_id;
              const found = traceId === undefined ? undefined : late.get(traceId);
              const foundEvents = traceId === undefined ? undefined : eventsLate.get(traceId);
              const eventsTrace = step.observed?.events?.trace_id;
              const foundPath = eventsTrace === undefined ? undefined : paths.get(eventsTrace);
              return {
                ...step,
                ...(found === undefined ? {} : { program_log_late: found }),
                ...(foundEvents === undefined ? {} : { events_late: foundEvents }),
                ...(foundPath === undefined ? {} : { path: foundPath }),
              };
            }),
          };
        }
      }
      if (recounted.length > 0) {
        const placeKey = (scenario: number, step: number, key: string): string => `${scenario}\u0000${step}\u0000${key}`;
        const recountedAt = new Map(places.flatMap((place, index) => (recounted[index] === undefined ? [] : [[placeKey(place.scenario, place.step, place.key), recounted[index]!] as const])));
        passIndexes.forEach((index, position) => {
          const judged = withAfterWorldStop(runScenarios[index]!, (step, key) => recountedAt.get(placeKey(position, step, key)));
          if (judged === runScenarios[index]) return;
          const cell = cellOf[index]!;
          if (cell.key === null) {
            runScenarios[index] = { ...judged, for_paths: forPathsOf(judged, cell.inThen) };
            return;
          }
          runScenarios[index] = judged;
          const outcomes = [...(cellOutcomes.get(cell.key) ?? [])];
          outcomes[cell.at] = executionOutcome(judged, cell.inThen);
          cellOutcomes.set(cell.key, outcomes);
        });
      }
      if (exitedEarly !== null) warn({ severity: "warning", code: "program-exited", message: `world ${tree === "head" ? name : `${name} (${tree})`}: ${exitedEarly}` });
    };
    const git = await probeGitState(rootDir);
    // Under `--base`, the criteria and the mapping are compared with the
    // ref, and the trees made, before the first scenario runs (this file's
    // header). A failure here still writes nothing: no scenario ran.
    const projectRelative = (filePath: string): string => path.relative(rootDir, path.resolve(rootDir, filePath));
    if (baseRef !== undefined) {
      // A signal while the trees are made waits for them, then removes them
      // and the worktree registration: the default action would exit past
      // every listener that could.
      const signals = installProcessSignalHandlers();
      processSignal = signals;
      const preparing = prepareBase({
        rootDir,
        envs: options.envs,
        config,
        headProgram: program,
        ref: baseRef.ref,
        commit: baseRef.commit,
        runDir: runDirAbsolute,
        // Every targeted file, the left out included: a file the run
        // left out entirely is still in the ref's comparison, and its
        // criteria are not removed.
        features: targetedFeatures.map((feature) => ({ relativePath: feature.relativePath, source: feature.source })),
        selected: new Set(flatPickles.map(({ feature, pickle }) => criterionKey(feature.relativePath, pickle.location?.line ?? 0))),
        targets:
          options.featureArgs.length === 0
            ? null
            : [...new Set(featureArgs.map((featureArg) => projectRelative(parseFeatureTarget(featureArg).relativePath)))],
      });
      signals.setProcessCleanup(async () => {
        await (await preparing.catch(() => undefined))?.cleanup();
      });
      try {
        prepared = await preparing;
      } catch (error) {
        if (signals.interrupted) await signals.untilExit();
        try {
          rmdirSync(runDirAbsolute);
        } catch {
          // Not empty, or never made.
        }
        if (error instanceof BaseSetupError) return refused(error.message, "base-features-at-root");
        // git names the base tree by its absolute path; the refusal names
        // it from the project root, as every printed path is.
        if (error instanceof GitRefError) {
          return refused(projectRelativeText(`nuka run --base ${baseRef.ref} could not compare with the base: ${error.message}`, rootDir), "base-git-failed");
        }
        throw error;
      }
      if (signals.interrupted) await signals.untilExit();
      signals.setProcessCleanup(null);
      for (const entry of prepared.unparsed) {
        warn({
          severity: "warning",
          code: "base-feature-unparsed",
          file: entry.feature,
          message: projectRelativeText(`the base's copy of this feature file does not parse, so its criteria were not compared and count as new: ${entry.message}`, rootDir),
        });
      }
    }
    const base = prepared;
    const old = base === undefined ? undefined : oldPlaces(base.criteria.changes);
    // The old world's environments are the ref's (src/run/base-run.ts),
    // head's when the ref has no program file; when the ref's did not
    // load, its cells stand in head's environments and say why.
    const oldEnvironments: readonly TableEnvironment[] =
      base === undefined || base.oldEnvironments === null || "problem" in base.oldEnvironments ? tableEnvironments : base.oldEnvironments;
    const oldRolesOf = (tags: readonly string[]): { environment: string; role: CellRole }[] =>
      rolesOf(tags, oldEnvironments).map((role, index) => ({ environment: oldEnvironments[index]!.name, role }));
    // Each scenario's run.json entry is built when its record arrives, from
    // the step records it cites, so a `--repeat` run never holds more than
    // one scenario's step records at a time. The lines and step names come
    // from the pickle the record ran, found by its feature and line.
    const pickleLines = new Map<string, (index: number) => number | null>();
    const pickleOutcomes = new Map<string, readonly boolean[]>();
    const documentLines = new Map<string, Map<string, number>>();
    for (const { feature, pickle } of flatPickles) {
      let lines = documentLines.get(feature.relativePath);
      if (lines === undefined) {
        lines = gherkinStepLines(feature.gherkinDocument);
        documentLines.set(feature.relativePath, lines);
      }
      const key = criterionKey(feature.relativePath, pickle.location?.line ?? 0);
      pickleLines.set(key, pickleStepLines(pickle, lines));
      pickleOutcomes.set(key, pickle.steps.map((step) => step.type === PickleStepType.OUTCOME));
    }
    const inThenOf = (feature: string, line: number) => (index: number): boolean => pickleOutcomes.get(criterionKey(feature, line))?.[index] ?? false;
    // Each selected criterion's role in each environment, from its tags and
    // what the environments declare (src/condition/condition.ts), and each
    // cell's executions so far, read for the table: the proof runs below
    // are decided from them, so a control is run again while it keeps
    // breaking the same claim at the same Then line. A base or an old cell
    // is keyed by its row's head feature and line, and its world.
    const cellKey = (feature: string, line: number, environment: string, world: RunWorldName = "head"): string =>
      `${feature}\u0000${line}\u0000${environment}\u0000${world}`;
    const roleByCell = new Map<string, CellRole>();
    for (const { feature, pickle } of flatPickles) {
      const line = pickle.location?.line ?? 0;
      const roles = rolesOf(pickle.tags.map((tag) => tag.name), tableEnvironments);
      tableEnvironments.forEach((environment, index) => roleByCell.set(cellKey(feature.relativePath, line, environment.name), roles[index]!));
    }
    const roleOf = (feature: string, line: number, environment: string): CellRole => roleByCell.get(cellKey(feature, line, environment)) ?? "required";
    const cellOutcomes = new Map<string, ExecutionOutcome[]>();
    // Why a proof round could not record a control's run, under
    // --concurrency (src/run/run-concurrent.ts).
    const proofProblems = new Map<string, string>();
    const needsProof = (feature: string, line: number, environment: string, world: RunWorldName = "head"): boolean =>
      needsProofRun(roleOf(feature, line, environment), cellOutcomes.get(cellKey(feature, line, environment, world)) ?? [], proofRuns, world);
    // Why a pass ran no scenario, for its cells that did not run.
    const beforeAllFailedIn = new Set<string>();
    // Why a pass of a tree left cells that did not run, by world and
    // environment.
    const treeNotRun = new Map<string, string>();
    const treeKey = (world: RunWorldName, environment: string): string => `${world}\u0000${environment}`;
    // Each selected row by its key, for an old record, which names the
    // ref's file and line.
    const rowByKey = new Map<string, { feature: string; line: number }>();
    for (const { feature, pickle } of flatPickles) {
      rowByKey.set(criterionKey(feature.relativePath, pickle.location?.line ?? 0), { feature: feature.relativePath, line: pickle.location?.line ?? 0 });
    }
    const stepKind = (name: string): "claim" | "run" | "compat" | null => {
      const entry = vocabulary.get(name);
      if (entry === undefined) return null;
      if (entry.kind === "compat") return "compat";
      return isClaimStep(entry.step) ? "claim" : "run";
    };
    const runScenarios: RunScenario[] = [];
    // The flags each execution's steps evaluated, by scenario record id,
    // filled as each world stops, for run.json's `flags`.
    const flagEvaluations = new Map<string, readonly FlagEvaluation[]>();
    // Each entry's cell, and its execution's place among the cell's
    // outcomes, by the entry's index: the world's stop can judge an entry
    // again (stopWorld). An execution the base ran for paths alone has no
    // cell (`key: null`).
    const cellOf: { readonly key: string | null; readonly at: number; readonly inThen: (index: number) => boolean }[] = [];
    // The requests each execution's steps sent that a `request` line
    // reports, the same way, for run.json's `routes`.
    const requestsServed = new Map<string, readonly ServedRequest[]>();
    // A scenario's evidence directory is made before it runs, so its id is
    // taken on disk for every worker of the run, and most scenarios leave it
    // empty. Those are removed once the run is over, not when the scenario
    // ends: a later scenario of the same run must not draw the same id.
    const emptyEvidenceDirs: string[] = [];
    // A record of the base or the old world (`tree`): a cell of the row
    // `row` names, whose lines are where it ran in its tree, or, with
    // `forPaths`, an execution of that row the base ran for run.json's
    // `paths` alone, which no cell holds. Its step names are head's only in
    // the base world, whose mapping is head's; it gets no rerun line, since
    // a rerun runs head.
    interface TreeRecord {
      readonly world: "base" | "old";
      readonly forPaths?: true;
      readonly row: { readonly feature: string; readonly line: number };
      readonly stepLine: (index: number) => number | null;
      readonly inThen: (index: number) => boolean;
    }
    const noteRecord = (record: ScenarioRecord, tree?: TreeRecord): void => {
      const stepRecords = readStepRecordsForScenario(rootDir, config.stateDir, record);
      for (const [stepRecordId, stepRecord] of stepRecords) {
        if (stepRecord !== null) continue;
        warn({
          severity: "warning",
          code: "step-record-unreadable",
          message: `${stepRecordRelativeDir(config.stateDir, runId, stepRecordId)}/record.json of ${record.feature}:${record.line} could not be read, so run.json has no declaration or measurement for that step`,
        });
      }
      const row = tree?.row ?? { feature: record.feature, line: record.line };
      const inThen = tree?.inThen ?? inThenOf(record.feature, record.line);
      const built = buildRunScenario(record, {
        stepRecords,
        stepLine: tree?.stepLine ?? pickleLines.get(criterionKey(record.feature, record.line)) ?? (() => null),
        stepName: (text) => {
          if (tree?.world === "old") return null;
          const { stepNames } = matchPickleStepText(text, patterns);
          return stepNames.length === 1 ? stepNames[0]! : null;
        },
        recordPath: (stepRecordId) => path.join(RUN_FILE_DIRS.steps, stepRecordId),
        evidenceDir: relativeToRun(config.stateDir, runId, record.evidence.dir),
        rerun: formatRerunCommand(record, conditionsOf.rerunFlags(record.environment)),
        inThen,
        stepKind,
      });
      // A control's failure is what the table reads as proof, so it gets no
      // rerun line: the reruns a reader is offered are of failures.
      const role = roleOf(row.feature, row.line, record.environment);
      const { do: rerun, ...withoutRerun } = built;
      const placed: RunScenario =
        tree === undefined
          ? { ...(role === "control" || rerun === undefined ? withoutRerun : built), role }
          : { ...withoutRerun, role, world: tree.world, row: { feature: row.feature, line: row.line } };
      const entry = tree?.forPaths === true ? { ...placed, for_paths: forPathsOf(placed, inThen) } : placed;
      runScenarios.push(entry);
      if (tree?.forPaths === true) {
        cellOf.push({ key: null, at: -1, inThen });
      } else {
        const key = cellKey(row.feature, row.line, record.environment, tree?.world ?? "head");
        const outcomes = cellOutcomes.get(key) ?? [];
        cellOf.push({ key, at: outcomes.length, inThen });
        cellOutcomes.set(key, [...outcomes, executionOutcome(entry, inThen)]);
      }
      if (entry.evidence === undefined) emptyEvidenceDirs.push(path.join(rootDir, record.evidence.dir));
      stdout.write(`${JSON.stringify(entry)}\n`);
    };
    // A location line names a file that exists: a run.json that was not
    // written is the `run-result-not-written` finding instead.
    const summaryLocation = (relativePath: string | null, runResultWritten: boolean) => [
      ...(relativePath === null ? [] : [{ label: "summary", relativePath, kind: "file" as const }]),
      ...(runResultWritten ? [{ label: "run", relativePath: runResultRelativePath(config.stateDir, runId), kind: "file" as const }] : []),
    ];

    // The end of a run, in the order each part needs the one before it.
    // Retention runs first, so run.json holds the findings it raises; the
    // run being finished counts as a run but is never removed. The document
    // is built next and run.json is written, then the summary is rendered
    // from that document, so a run.json that could not be written is a
    // failed run in the summary and in $GITHUB_STEP_SUMMARY too, never a
    // green one beside a red exit. A run with no pickle wrote nothing and
    // gets neither file. A summary that was not written is a warning. A
    // run.json that was not written fails the run: it is the record every
    // later command reads, so a green exit without it would claim evidence
    // that does not exist. Its finding is added to the document before the
    // summary is rendered and before the document is printed, so the
    // summary and `--json` carry it too. A summary that was not written is
    // added after the summary is rendered, and before the document is
    // printed. Returns the root-relative path of the summary in the
    // run directory, or `null`, and the exit code.
    const finishRun = async (
      verdict: "passed" | "failed",
      failedScenarios: readonly FailedScenario[],
    ): Promise<{
      summaryPath: string | null;
      retention: string | null;
      runResultWritten: boolean;
      exitCode: number;
      notRun: number;
      controls: ControlCounts;
      notes: readonly Finding[];
      criteria: CriteriaCounts | null;
      rows: readonly Finding[];
    }> => {
      // Every request a step was counted for gets its line before run.json
      // is written, one its step left open after it ended included. Under
      // `--concurrency` each worker has done this for its own requests.
      finalizeOpenRequests();
      // Read from the run's own scenario entries and the step records they
      // cite, which are on disk by now, so the notes reach run.json in its
      // one write, and a run another process finishes meanwhile is never
      // the one measured.
      // Head's executions only: the trees ran other code or other steps.
      const notes = findRepeatedScenarioPrefixes(
        path.join(rootDir, runRelativeDir(config.stateDir, runId)),
        runScenarios.filter((scenario) => scenario.world === undefined),
        selected.features,
      );
      runFindings.push(...failedScenarioFindings(failedScenarios, conditionsOf), ...notes);
      // The run's `scenarios/` goes too once no scenario left evidence in it.
      for (const dir of [...emptyEvidenceDirs, path.join(rootDir, runRelativeDir(config.stateDir, runId), RUN_FILE_DIRS.scenarios)]) {
        try {
          rmdirSync(dir);
        } catch {
          // Not empty after all, or already gone: nothing to remove.
        }
      }
      let retention: string | null = null;
      try {
        const outcome = await applyRetention({
          rootDir,
          stateDir: config.stateDir,
          policy: config.retention,
          now: new Date(),
          currentRun: { runId, startedAt: invocationStartedAt.getTime() },
        });
        retention = formatRetention(outcome, config.retention);
      } catch (error) {
        warn({ severity: "warning", code: "retention-failed", message: `retention failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      const table = buildTable({
        criteria: flatPickles.map(({ feature, pickle }) => ({
          feature: feature.relativePath,
          line: pickle.location?.line ?? 0,
          name: pickle.name,
          tags: pickle.tags.map((tag) => tag.name),
        })),
        environments: tableEnvironments,
        outcomes: (feature, line, environment, world = "head") => cellOutcomes.get(cellKey(feature, line, environment, world)) ?? [],
        notRunReason: (environment, world = "head") => {
          if (world !== "head") return treeNotRun.get(treeKey(world, environment));
          if (worlds.some((entry) => entry.tree === "head" && entry.name === environment && entry.error !== null)) return "the program did not start for its world";
          if (beforeAllFailedIn.has(environment)) return "a BeforeAll hook failed";
          return undefined;
        },
        proofRuns,
        leftOut,
        proofProblem: (feature, line, environment) => proofProblems.get(cellKey(feature, line, environment)),
        ...(base === undefined
          ? {}
          : {
              base: {
                ref: base.ref,
                commit: base.commit,
                mapping: base.mappingChanges,
                mappingChanged: base.mapping.changed,
                changeOf: (feature: string, line: number) => {
                  const found = base.criteria.changes.get(criterionKey(feature, line));
                  // Every selected pickle was compared before the run
                  // started, so a row without a change is a bug here.
                  if (found === undefined) throw new Error(`${feature}:${line} ran but was not compared with the base`);
                  return found.change === "unchanged"
                    ? {
                        change: "unchanged" as const,
                        ...(found.renamedFrom === undefined ? {} : { renamedFrom: found.renamedFrom }),
                        ...(found.retagged === true ? { retagged: true as const } : {}),
                      }
                    : { change: found.change };
                },
                removed: base.criteria.removed.map((criterion) => ({
                  feature: criterion.feature,
                  line: criterion.line,
                  name: criterion.name,
                  tags: criterion.tags,
                  lines: criterion.lines,
                })),
                oldEnvironments,
              },
            }),
      });
      // A red row with no required cell has no failed execution to carry
      // its finding, so it gets one of its own. An environment the run did
      // not start that meets the row is the one its `do:` line runs.
      const rows = rowsWithoutRequiredCell(table, tableEnvironments, (tags) => {
        const { conditions } = readCriterionTags(tags);
        return Object.entries(program?.environments ?? {}).find(
          ([name, environment]) => !envs.includes(name) && roleIn(conditions, environment.conditions) === "required",
        )?.[0];
      });
      // An unproven or moved row has no failed execution either, so it gets
      // one too, whose `do:` judges it again against the same base: the
      // commit the ref resolved to, since a branch or `HEAD` can move
      // before the line runs.
      if (base !== undefined) rows.push(...judgedRowFindings(table, base.commit, rerunFlags, base.obstacles));
      // A cell a claim judged too early made broke may sit under a
      // scenario that passed, whose line says nothing failed.
      rows.push(...judgedEarlyFindings(runScenarios, conditionsOf));
      runFindings.push(...rows);
      // Each environment whose flags list was read, in the run's order.
      const listedFlags = passes.flatMap((pass) => {
        const flags = listedPlaces.get(pass.resolvedEnv.name)?.flags;
        return flags === undefined ? [] : [{ environment: pass.resolvedEnv.name, flags }];
      });
      const flags = flagRows({ scenarios: runScenarios, evaluated: (id) => flagEvaluations.get(id) ?? [], table, listed: listedFlags });
      // Each environment whose routes list was read, in the run's order.
      // With none, a run has no list to set its requests against, so it
      // has no `routes` at all, never one that reads as nothing listed.
      const listedRoutes = passes.flatMap((pass) => {
        const routes = listedPlaces.get(pass.resolvedEnv.name)?.routes;
        return routes === undefined ? [] : [{ environment: pass.resolvedEnv.name, routes }];
      });
      const routes = listedRoutes.length === 0 ? undefined : routeRows({ scenarios: runScenarios, table, served: (id) => requestsServed.get(id) ?? [], listed: listedRoutes });
      const environments = passes.map((pass) => ({
        name: pass.resolvedEnv.name,
        // Unlike a scenario record, run.json is not redacted as a whole,
        // and a version probe can answer with a secret value.
        target_version: pass.targetVersion === undefined ? null : redactString(pass.targetVersion, pass.secrets),
        base_url: worlds.find((world) => world.tree === "head" && world.name === pass.resolvedEnv.name)?.url ?? null,
        ...(pass.resolvedEnv.conditions === undefined ? {} : { conditions: pass.resolvedEnv.conditions }),
      }));
      const paths = comparePaths({ scenarios: runScenarios, table, environments, worlds });
      const fields: RunFields = {
        run_id: runId,
        run_dir: runRelativeDir(config.stateDir, runId).split(path.sep).join("/"),
        started_at: invocationStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        commit: git === undefined ? null : { sha: git.commit, dirty: !git.clean },
        environments,
        // Each world's record is redacted with its own values already.
        worlds,
        selection,
        check: options.check ? "ran" : "skipped",
        counts: countScenarios(runScenarios, table),
        scenarios: runScenarios,
        table,
        ...(flags.length === 0 ? {} : { flags }),
        ...(routes === undefined ? {} : { routes }),
        ...(paths.length === 0 ? {} : { paths }),
        ...(walk === undefined ? {} : { walk: walk.record() }),
      };
      // The gate: red when the run failed outside the table, or when a row
      // is red, which a run with no failed execution can still have: a
      // criterion no environment of the run meets, under `--no-check`, or,
      // under `--base`, one nothing proves or whose meaning moved.
      let exitCode = verdict === "passed" && !table.rows.some((row) => RED_VERDICTS.has(row.verdict)) ? 0 : 1;
      // sources.json first, before anything is serialized, so a failure to
      // write it is a finding in the summary, in run.json, and in the
      // `--json` document alike. It fails the run, as run.json does: without
      // it `nuka report` cannot render the run at all.
      if (flatPickles.length > 0) {
        try {
          writeRunSources(rootDir, config.stateDir, runId, {
            project: resolveProjectName(rootDir),
            features: selected.features.map((feature) => ({ path: feature.relativePath, source: feature.source })),
          });
        } catch (error) {
          warn({ severity: "failed", code: "run-sources-not-written", message: `sources.json was not written: ${error instanceof Error ? error.message : String(error)}` });
          exitCode = 1;
        }
      }
      let document = formatEnvelope("run", exitCode, runFindings, fields);
      let runResultWritten = false;
      if (flatPickles.length > 0) {
        try {
          writeRunResult(rootDir, config.stateDir, runId, document);
          runResultWritten = true;
        } catch (error) {
          warn({ severity: "failed", code: "run-result-not-written", message: `run.json was not written: ${error instanceof Error ? error.message : String(error)}` });
          exitCode = 1;
          document = formatEnvelope("run", exitCode, runFindings, fields);
        }
      }
      let summaryPath: string | null = null;
      if (flatPickles.length > 0) {
        const markdown = renderRunSummary(JSON.parse(document));
        const written = writeRunSummaryFiles(markdown, {
          rootDir,
          stateDir: config.stateDir,
          runId,
          stepSummaryPath,
        });
        for (const warning of written.warnings) warnings("summary-not-written").write(`${warning}\n`);
        summaryPath = written.runSummaryPath;
        // A summary that was not written is a finding of the run, so the
        // document is serialized again with it, for `--json` and for
        // run.json alike. The verdict stays the one the run.json write
        // decided: a missing summary is a warning, never a failure. A
        // second write that fails leaves the first run.json, which differs
        // only by this warning.
        if (written.warnings.length > 0) {
          document = formatEnvelope("run", exitCode, runFindings, fields);
          if (runResultWritten) {
            try {
              writeRunResult(rootDir, config.stateDir, runId, document);
            } catch {
              // The first run.json stands.
            }
          }
        }
      }
      // After run.json, so a `nuka step` that reads the walk as ended finds
      // the run's record there.
      const stopped = runScenarios.find((scenario) => scenario.stopped !== undefined)?.stopped;
      walk?.end({ how: "finished", exit_code: exitCode, findings: runFindings, ...(stopped === undefined ? {} : { stopped }) });
      if (options.json) options.stdout.write(document);
      // The criteria line is for a run with a control cell or a base, the
      // only kinds whose verdicts the scenario count above it cannot tell.
      const withControl = table.rows.some((row) => row.cells.some((cell) => cell.role === "control"));
      const count = (word: (typeof table.rows)[number]["verdict"]): number => table.rows.filter((row) => row.verdict === word).length;
      const criteria =
        base !== undefined
          ? { held: count("held"), proven: count("proven"), failed: count("failed"), unproven: count("unproven"), moved: count("moved"), removed: count("removed") }
          : withControl
            ? { held: count("held"), proven: count("proven"), failed: count("failed") }
            : null;
      return {
        summaryPath,
        retention,
        runResultWritten,
        exitCode,
        notRun: fields.counts.not_run,
        controls: { runs: fields.counts.controls, notRun: fields.counts.controls_not_run },
        notes,
        criteria,
        rows,
      };
    };
    // The text a person reads at the end, after the files are written: where
    // they are, the count, each failed scenario, the repeat tallies, and
    // what retention removed.
    const writeRunEnd = (
      locations: Parameters<typeof writeOutputLocations>[1],
      counts: { total: number; passed: number },
      failedScenarios: readonly FailedScenario[],
      tallies: Parameters<typeof writeRepeatTallies>[1],
      end: {
        summaryPath: string | null;
        retention: string | null;
        runResultWritten: boolean;
        notRun?: number;
        controls?: ControlCounts;
        notes?: readonly Finding[];
        criteria?: CriteriaCounts | null;
        rows?: readonly Finding[];
      },
    ): void => {
      writeOutputLocations(progress, [...locations, ...summaryLocation(end.summaryPath, end.runResultWritten)]);
      // A walk a person stopped did not fail, so the count says stopped.
      const stopped = failedScenarios.filter((failure) => failure.stopped !== undefined).length;
      writeRunSummary(progress, {
        total: counts.total,
        passed: counts.passed,
        failed: counts.total - counts.passed - stopped,
        ...(stopped > 0 ? { stopped } : {}),
        ...(end.notRun !== undefined ? { notRun: end.notRun } : {}),
        durationMs: Date.now() - invocationStartedAt.getTime(),
      });
      if (end.controls !== undefined) writeControlCounts(progress, end.controls);
      if (end.criteria !== undefined && end.criteria !== null) writeCriteriaCounts(progress, end.criteria);
      if (leftOut > 0) progress.write(`${leftOutText(leftOut)}\n`);
      for (const finding of [...failedScenarioFindings(failedScenarios, conditionsOf), ...(end.rows ?? []), ...(end.notes ?? [])]) {
        progress.write(formatFinding(withHint(finding)));
      }
      writeRepeatTallies(progress, tallies, conditionsOf);
      if (end.retention !== null) progress.write(`${end.retention}\n`);
    };
    // One instance for this whole `nuka run` invocation — passed unchanged
    // into every `runScenario` call below, so a run whose several steps
    // (across one scenario or several) each hit an unreadable trace
    // version still only ever writes the stderr warning once, not once per
    // occurrence.
    const onUnknownTraceVersion = createTraceVersionWarner(warnings("trace-version-unknown"));
    const onRequestScreenFailed = createRequestScreenWarner(warnings("show-requests-failed"));

    // Same "one instance, threaded unchanged into every `runScenario` call"
    // shape as `onUnknownTraceVersion` just above.
    const onStepEnd = createStepProgressLogger(progress, { stateDir: config.stateDir, runId });

    // Runs one BeforeAll/AfterAll
    // registration, in isolation — `label` is only ever "BeforeAll" or
    // "AfterAll" here, but shares `doneCallbackMessage`/
    // `pendingOrSkippedMessage`'s own `"Hook"` kind (their wording doesn't
    // otherwise distinguish a scenario hook from a run-scope one). Every
    // failure is reported to stderr right here — the one place both loops
    // below need it — and reported back as a boolean rather than thrown, so
    // each loop decides for itself whether a failure stops the rest
    // (BeforeAll: yes: AfterAll: no — see this file's own header).
    // A run-scope hook belongs to one environment's pass, so its finding
    // names that environment, and its `do` reruns the same targets there.
    const runHookDo = (environment: string): string =>
      ["nuka", "run", ...options.featureArgs, ...conditionsOf.rerunFlags(environment)].map(shellWord).join(" ");
    const runOneRunHook = async (
      hook: (typeof compatRunHooks)[number],
      label: "BeforeAll" | "AfterAll",
      environment: string,
    ): Promise<boolean> => {
      const title = hookDisplayTitle(label, hook.name);
      try {
        // Same arity-based done-callback signal as src/run/run-scenario.ts's
        // own hooks, adjusted for a run-scope hook's own zero-argument call
        // convention (src/compat/run-hooks.ts's `RunHookFn` header): *any*
        // declared parameter, not just a second one, is the signal here.
        if (declaresDoneCallback(hook.fn.length, RUN_HOOK_ARG_COUNT)) {
          throw new Error(doneCallbackMessage("Hook", title));
        }
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(undefined)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          title,
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          throw new Error(pendingOrSkippedMessage("Hook", title, returnValue));
        }
        return true;
      } catch (error) {
        warn({
          severity: "failed",
          code: "hook-failed",
          message: `${title} failed in environment "${environment}": ${error instanceof Error ? error.message : String(error)}`,
          do: runHookDo(environment),
        });
        return false;
      }
    };

    // The base and the old world of `--base`, after head's pass (this
    // file's header): each row's head cells decide which of their cells it
    // needs, and each tree runs those, one environment at a time, against
    // a world built from that tree. The base world builds and starts the
    // base tree's program file, from which it reads its environments and
    // their conditions; the old world runs head's code, so it starts
    // head's recipe in the old tree. A signal stops the workers first
    // (SIGTERM, a world's grace period, then SIGKILL), then aborts a
    // tree world's start or stops the tree world, as head's pass does with
    // its own, and then removes the trees: a program left running in a
    // removed tree would outlive nukadoko.
    const runOtherWorlds = async (): Promise<void> => {
      if (base === undefined || old === undefined) return;
      const live = new Set<ChildProcess>();
      let treeStart: { readonly abort: AbortController; readonly starting: Promise<unknown> } | null = null;
      let treeWorld: StartedWorld | null = null;
      processSignal ??= installProcessSignalHandlers();
      const signals = processSignal;
      signals.setProcessCleanup(async () => {
        await stopTreeWorkers(live);
        if (treeStart !== null) {
          treeStart.abort.abort();
          await treeStart.starting.catch(() => {});
        }
        await treeWorld?.stop();
        await base.cleanup();
      });
      const serialOf = (document: { readonly feature?: { readonly tags: readonly { readonly name: string }[] } }): boolean =>
        document.feature?.tags.some((tag) => tag.name === "@nukadoko:serial") ?? false;
      const planned = new Map<string, ReturnType<typeof plannedWorldCells>>();
      for (const { feature, pickle } of flatPickles) {
        const line = pickle.location?.line ?? 0;
        const key = criterionKey(feature.relativePath, line);
        const compared = base.criteria.changes.get(key);
        const change = compared?.change ?? "new";
        const headCells = tableEnvironments.map((environment) => {
          const role = roleOf(feature.relativePath, line, environment.name);
          const at = cellKey(feature.relativePath, line, environment.name);
          return { environment: environment.name, role, ...foldHeadCell(cellOutcomes.get(at) ?? [], role, line, proofProblems.get(at)) };
        });
        const context = {
          change,
          held: readCriterionTags(pickle.tags.map((tag) => tag.name)).held,
          mappingChanged: base.mapping.changed,
          retagged: compared?.change === "unchanged" && compared.retagged === true,
          renamed: compared?.change === "unchanged" && compared.renamedFrom !== undefined,
        };
        planned.set(key, plannedWorldCells(headCells, proofRuns, context, oldRolesOf(pickle.tags.map((tag) => tag.name))));
      }
      // A tree's cells that will not run say why on stderr too, beside the
      // count line that shows the rows they turn red.
      const leaveNotRun = (world: "base" | "old", environment: string, reason: string): void => {
        treeNotRun.set(treeKey(world, environment), reason);
        progress.write(`${world} ${environment}  not run: ${reason}\n`);
      };
      // The old world's pass in an environment the ref's mapping requires:
      // head's, or one for head's recipe of that name when head's run did
      // not select it. An environment head no longer has cannot run the
      // ref's mapping on head's code, so its cells say so.
      const oldPassOf = async (environment: string): Promise<EnvironmentPass | string> => {
        if (base.oldEnvironments !== null && "problem" in base.oldEnvironments) {
          return projectRelativeText(`the base's program file did not load, so the environments its mapping requires are not known: ${base.oldEnvironments.problem}`, rootDir);
        }
        const known = passes.find((pass) => pass.resolvedEnv.name === environment);
        if (known !== undefined) return known;
        if (environment !== DEFAULT_ENVIRONMENT_NAME && !Object.hasOwn(program?.environments ?? {}, environment)) {
          return "the base's mapping requires this environment, and head's program file no longer has it";
        }
        try {
          const resolvedEnv = resolveEnvironment(config, program, environment, true);
          return { resolvedEnv, envArg: environment, ...(await readEnvFiles(resolvedEnv.envFiles)), targetVersion: undefined };
        } catch (error) {
          return `its env files could not be read: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      const trees = [
        { world: "base" as const, tree: base.base, environments: tableEnvironments },
        { world: "old" as const, tree: base.old, environments: oldEnvironments },
      ];
      for (const { world, tree, environments } of trees) {
        // A world with an obstacle was not built (src/run/base-run.ts):
        // each environment with a cell planned in it says why.
        const obstacle = base.obstacles.find((entry) => entry.world === world);
        if (obstacle !== undefined) {
          for (const { name } of environments) {
            if ([...planned.values()].some((cells) => cells[world].includes(name))) leaveNotRun(world, name, obstacle.reason);
          }
          continue;
        }
        if (tree === null) continue;
        const starter = createWorldStarter({
          rootDir: tree.root,
          // `@` is in no environment name, so a tree's world directory
          // never meets head's.
          worldDir: (name) => path.join(runDirAbsolute, "worlds", `${name}@${world}`),
          recordPath: (absolutePath) => path.relative(runDirAbsolute, absolutePath).split(path.sep).join("/"),
          displayPath: (absolutePath) => path.relative(rootDir, absolutePath).split(path.sep).join("/"),
          // A tree's commands are filled with the tree's absolute paths
          // (`{root}`, `{dir}`), and every path nukadoko prints is
          // relative to the project, so its lines name them from there.
          progress: { write: (chunk: string) => progress.write(projectRelativeText(chunk, rootDir)) },
          tree: world,
          programFromHead: world === "base" && base.base?.programFromHead === true,
          headUrls,
        });
        for (const { name: environment } of environments) {
          // A signal ends the run, so no tree world starts after it.
          if (signals.interrupted) break;
          const targets: TreeTarget[] = [];
          // The rows the base world would run for paths alone: every one
          // whose head cell here is required and ran, and that no cell of
          // the base already runs.
          const forPaths: TreeTarget[] = [];
          for (const { feature, pickle } of flatPickles) {
            const line = pickle.location?.line ?? 0;
            const key = criterionKey(feature.relativePath, line);
            if (!(planned.get(key)?.[world] ?? []).includes(environment)) {
              const ran = (cellOutcomes.get(cellKey(feature.relativePath, line, environment))?.length ?? 0) > 0;
              if (world === "base" && ran && roleOf(feature.relativePath, line, environment) === "required") {
                forPaths.push({ feature: feature.relativePath, line, serial: serialOf(feature.gherkinDocument), forPaths: true });
              }
              continue;
            }
            if (world === "base") {
              targets.push({ feature: feature.relativePath, line: pickle.location?.line ?? 0, serial: serialOf(feature.gherkinDocument) });
            } else {
              const at = old.at.get(key);
              if (at === undefined) continue;
              const document = base.refFeatures.get(at.feature)?.gherkinDocument;
              targets.push({ feature: at.feature, line: at.line, serial: document === undefined ? false : serialOf(document) });
            }
          }
          if (targets.length === 0 && forPaths.length === 0) continue;
          const pass = world === "base" ? passes.find((entry) => entry.resolvedEnv.name === environment)! : await oldPassOf(environment);
          if (typeof pass === "string") {
            leaveNotRun(world, environment, pass);
            continue;
          }
          let recipe = pass.resolvedEnv.program;
          if (world === "base") {
            try {
              const baseProgram = (await loadProgram(tree.root))?.program ?? null;
              recipe = resolveEnvironment(config, baseProgram, environment, !implicitDefault).program;
            } catch (error) {
              // A row the base was to run for paths alone is no cell, so
              // only a planned cell needs the reason.
              if (targets.length > 0) {
                leaveNotRun(
                  world,
                  environment,
                  projectRelativeText(`the base tree's program file does not give this environment: ${error instanceof Error ? error.message : String(error)}`, rootDir),
                );
              }
              continue;
            }
          }
          // Paths are compared only where both sides write execution
          // events: a base that names no {events} would run a pass for
          // nothing to compare.
          if (writesEvents(pass.resolvedEnv.program) && writesEvents(recipe)) targets.push(...forPaths);
          if (targets.length === 0) continue;
          const pathRows = new Set(forPaths.map((target) => criterionKey(target.feature, target.line)));
          let started: StartedWorld | null = null;
          if (recipe !== null) {
            const abort = new AbortController();
            const starting = starter.start(environment, recipe, pass.secrets, abort.signal);
            treeStart = { abort, starting };
            const result = await starting;
            treeStart = null;
            if (signals.interrupted) await signals.untilExit();
            if (!result.ok) {
              if (result.unavailable === true) {
                leaveNotRun(world, environment, `the ${world} world has no URL to reach: ${result.message}`);
              } else {
                worlds.push(result.record());
                leaveNotRun(world, environment, result.aborted ? `a signal stopped the start of the ${world} world` : `the program did not start for the ${world} world`);
                if (!result.aborted) warn({ severity: "warning", code: "program-start-failed", message: result.message });
              }
              continue;
            }
            started = result;
            treeWorld = result;
            warnListsUnread(result);
          }
          const result = await runTreePass({
            world,
            treeRoot: tree.root,
            headRoot: rootDir,
            headStateDir: config.stateDir,
            headSecrets: { envFiles: pass.resolvedEnv.envFiles, publicKeys: config.secrets.public, redactKeys: config.secrets.redact },
            runId,
            envArg: pass.envArg,
            environment,
            check: options.check,
            concurrency,
            targets,
            view: started?.view ?? null,
            needsProof: (feature, line) => world === "base" && needsProof(feature, line, environment, "base"),
            runsOf: (feature, line) => cellOutcomes.get(cellKey(feature, line, environment, world))?.length ?? 0,
            proofRuns,
            onRecord: (record) => {
              if (world === "base") {
                noteRecord(record, {
                  world,
                  ...(pathRows.has(criterionKey(record.feature, record.line)) ? { forPaths: true as const } : {}),
                  row: { feature: record.feature, line: record.line },
                  stepLine: pickleLines.get(criterionKey(record.feature, record.line)) ?? (() => null),
                  inThen: inThenOf(record.feature, record.line),
                });
                return;
              }
              const rowKey = old.rowOf(record.feature, record.line);
              const row = rowKey === undefined ? undefined : rowByKey.get(rowKey);
              const refFeature = base.refFeatures.get(record.feature);
              const refPickle = refFeature?.pickles.find((pickle) => pickle.location?.line === record.line);
              if (row === undefined || refFeature === undefined || refPickle === undefined) {
                warn({ severity: "warning", code: "record-unmatched", file: record.feature, line: record.line, message: "No row of the table matches the record the old world reported here" });
                return;
              }
              noteRecord(record, {
                world,
                row,
                stepLine: pickleStepLines(refPickle, gherkinStepLines(refFeature.gherkinDocument)),
                inThen: (index) => refPickle.steps[index]?.type === PickleStepType.OUTCOME,
              });
            },
            progress,
            warn,
            stderr,
            live,
            runDir: runDirAbsolute,
          });
          // The handler's SIGTERM stopped the pass's workers, so a cell
          // they left is the signal's and not a worker's failure, and the
          // handler exits once the trees are gone, with no run.json.
          if (signals.interrupted) await signals.untilExit();
          if (result.notRun !== null) leaveNotRun(world, environment, result.notRun);
          if (started !== null) await stopWorld(started, world);
          treeWorld = null;
        }
      }
      processSignal.setProcessCleanup(null);
      await base.cleanup();
    };

    // A target naming one file has nothing to distribute across more than
    // one worker, so `--concurrency` drops back to 1 with a one-line
    // reason (docs/spec.md "Scenarios (the scripted path)",
    // same category as the paths line), before any worker is spawned.
    let effectiveConcurrency = concurrency;
    if (effectiveConcurrency > 1 && selected.features.length <= 1) {
      effectiveConcurrency = 1;
      progress.write("--concurrency has nothing to distribute: this run selects one feature file.\n");
    }

    if (effectiveConcurrency > 1) {
      // The concurrent path forwards a signal to its workers with handlers
      // of its own, which a second listener's exit would cut short. Its
      // trees still go: the base run removes them on the process's exit.
      processSignal?.stop();
      processSignal = undefined;
      const {
        allPassed,
        scenariosWritten,
        scenariosPassed,
        failedScenarios,
        repeatTallies,
        interruptedBy,
      } = await runConcurrentPickles({
          rootDir,
          config,
          runId,
          repeat,
          runHookDo,
          passes: passes.map((pass) => ({
            envArg: pass.envArg,
            environment: pass.resolvedEnv.name,
            targetVersion: pass.targetVersion,
            secrets: pass.secrets,
            openWorld: async (abort) => {
              const world = await startWorld(pass, abort);
              if (world === null || world === "failed") return world;
              return { view: world.view, close: () => stopWorld(world) };
            },
          })),
          concurrency: effectiveConcurrency,
          selected,
          flatPickles,
          cells: {
            roleOf,
            needsProof,
            runsOf: (feature, line, environment) => cellOutcomes.get(cellKey(feature, line, environment))?.length ?? 0,
            proofRuns,
            onProofProblem: (feature, line, environment, reason) => proofProblems.set(cellKey(feature, line, environment), reason),
          },
          onRecord: noteRecord,
          onBeforeAllFailed: (environment) => beforeAllFailedIn.add(environment),
          progress,
          warn,
          stderr,
        });

      // An interrupted run prunes nothing and writes no run.json, as at
      // `--concurrency 1`, where the signal handler exits first.
      if (interruptedBy !== null) {
        writeRunEnd(stepsLocation(rootDir, config.stateDir, runId, scenariosWritten), { total: scenariosWritten, passed: scenariosPassed }, failedScenarios, repeatTallies, { summaryPath: null, retention: null, runResultWritten: false });
        return exitCodeForSignal(interruptedBy);
      }
      await runOtherWorlds();
      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(rootDir, config.stateDir, runId, scenariosWritten),
        { total: scenariosWritten, passed: scenariosPassed },
        failedScenarios,
        repeatTallies,
        end,
      );

      return end.exitCode;
    }

    // --- Execution phase proper: registered once for every pickle below
    // — see this file's own header. ---
    const restoreAllureRuntime = registerAllureRuntime();
    try {
      let allPassed = true;
      // Tallied alongside `allPassed` above, read by the summary/output-
      // location lines near this function's own `return` —
      // `scenariosWritten`/`scenariosPassed`
      // count actual `stdout.write`s below, never `flatPickles.length`:
      // a BeforeAll failure can leave this run with fewer scenario records than pickles selected,
      // and the summary line must say what actually happened, not what was
      // asked for.
      let scenariosWritten = 0;
      let scenariosPassed = 0;
      const failedScenarios: FailedScenario[] = [];

      // Skipped entirely for a run that selects zero pickles: no pickle
      // selected means BeforeAll/AfterAll never run —
      // `hasPickles` gates every step below, including AfterAll.
      const hasPickles = flatPickles.length > 0;

      processSignal ??= installProcessSignalHandlers();

      const beforeAllHooks = compatRunHooks.filter((hook) => hook.type === "beforeAll");
      // Same LIFO convention as src/run/run-scenario.ts's own After-hook
      // loop (that file's own comment: "teardown unwinds in the opposite
      // order setup ran in") — registration order reversed, so the most
      // recently registered AfterAll runs first.
      const afterAllHooks = compatRunHooks
        .filter((hook) => hook.type === "afterAll")
        .slice()
        .reverse();

      // Environment by environment, in the order `--env` named them: a
      // pass ends, its AfterAll and process fixtures included, before the
      // next begins, so two passes never share a moment or a fixture.
      const repeatTally = createRepeatTally();
      for (const [passIndex, pass] of passes.entries()) {
        if (conditionsOf.named && hasPickles) progress.write(`environment ${pass.resolvedEnv.name}\n`);
        let passPassed = true;
        // This environment's own `"process"`-scope fixture cache — one
        // instance, shared by every `runScenario`
        // call of its pass, so a `"process"`-scope fixture named by more than one
        // scenario is built exactly once per environment and torn down once, after
        // the pass
        // (below, near AfterAll). Cheap to create even for a zero-pickle run
        // — an empty cache's own teardown is a no-op.
        const fixtureProcessCache = createFixtureCache();
        // `"failed"` until the invocation's own outcome is known. A signal
        // during a scenario reads this, or `interrupted`, and reports
        // `"failed"` because that invocation did not finish.
        let processOutcome: FixtureOutcome = "failed";
        const tearDownProcessFixtures = runOnce(async () => {
          const outcome = processSignal?.interrupted === true ? "failed" : processOutcome;
          const processFixtureTeardownErrors = await teardownFixtureCache(fixtureProcessCache, outcome);
          for (const teardownError of processFixtureTeardownErrors) {
            // The line is the fixture's own text, with no scenario record to
            // redact it first.
            warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, pass.secrets) + "\n");
          }
        });
        // The pass's world, before BeforeAll: a hook may already talk to
        // the program. A signal while it starts aborts the start, which
        // stops what the start spawned and gives a running setup or url
        // function its signal, before the fixtures' teardown. A signal from
        // then on stops the world after the fixtures.
        const startAbort = new AbortController();
        const starting = hasPickles ? startWorld(pass, startAbort.signal) : Promise.resolve(null);
        processSignal.setProcessCleanup(async () => {
          startAbort.abort();
          await starting.catch(() => {});
          await tearDownProcessFixtures();
        });
        const world = await starting;
        processSignal.setProcessCleanup(tearDownProcessFixtures);
        const started = world === null || world === "failed" ? null : world;
        const restoreEnv = started === null ? () => {} : applyWorldEnv(started.view.env);
        if (started !== null) {
          processSignal.setProcessCleanup(async () => {
            await tearDownProcessFixtures();
            await started.stop();
          });
        }
        const passEnv = started === null ? pass.envVars : { ...pass.envVars, ...started.view.env };
        const passSecrets = started === null ? pass.secrets : [...pass.secrets, ...started.view.secrets];
        let beforeAllFailed = world === "failed";
        if (beforeAllFailed) passPassed = false;
        if (hasPickles && !beforeAllFailed) {
          for (const hook of beforeAllHooks) {
            const ok = await runOneRunHook(hook, "BeforeAll", pass.resolvedEnv.name);
            if (!ok) {
              beforeAllFailed = true;
              beforeAllFailedIn.add(pass.resolvedEnv.name);
              passPassed = false;
              // Stop at the first BeforeAll failure — same convention
              // as scenario-level Before.
              break;
            }
          }
        }

        // One execution of one pickle in this pass: its record, its run.json
        // entry, and the tallies. A control's failure is the table's to
        // read (src/run/verdict-table.ts), so it never counts as a failed
        // scenario here and never turns the pass red.
        const execute = async (feature: (typeof flatPickles)[number]["feature"], pickle: (typeof flatPickles)[number]["pickle"]): Promise<void> => {
          walk?.begin({
            run_id: runId,
            run_dir: runRelativeDir(config.stateDir, runId).split(path.sep).join("/"),
            scenario: { feature: feature.relativePath, line: pickle.location?.line ?? 0, name: pickle.name, environment: pass.resolvedEnv.name },
            world: started?.view.url === undefined ? null : { url: started.view.url },
          });
          const record = await runScenario({
            rootDir,
            config,
            programWorld: started?.view ?? null,
            pickle,
            relativeFeaturePath: feature.relativePath,
            gherkinDocument: feature.gherkinDocument,
            vocabulary,
            bindings,
            patterns,
            runId,
            git,
            environment: pass.resolvedEnv.name,
            policy: pass.resolvedEnv.policy,
            targetVersion: pass.targetVersion,
            env: passEnv,
            secrets: passSecrets,
            instantiateCompatWorld,
            onWorldSetupFailure: (message) => {
              warnings("world-setup-failed").write(`${message}\n`);
            },
            compatHooks,
            defaultTimeoutMs,
            onUnknownTraceVersion,
            onRequestScreenFailed,
            onStepEnd,
            fixtureGraph,
            fixtureProcessCache,
            processSignal,
            ...(walk === undefined ? {} : { pauseAfterStep: walk.pauseAfter }),
          });

          // One JSON line per completed scenario record, streamed as it
          // finishes; everything else about
          // this run goes to stderr, never stdout.
          noteRecord(record);
          // A `"scenario"`-scope fixture's own teardown failure, already
          // recorded on `record.teardown_
          // errors` (src/run/run-scenario.ts); announced here too, on
          // stderr, so it is never silent even though it never changes
          // `record.status` or this run's own exit code. Redacted on this
          // write as well: the record's copy is already redacted, and this
          // stderr line has to stay that way on its own.
          for (const teardownError of record.teardown_errors ?? []) {
            warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, pass.secrets) + "\n");
          }
          if (roleOf(record.feature, record.line, record.environment) === "control") return;
          scenariosWritten += 1;
          if (record.status === "passed") {
            scenariosPassed += 1;
          }
          if (repeat > 1) repeatTally.note(record);
          if (record.status !== "passed") {
            passPassed = false;
            failedScenarios.push(failedScenarioOf(record));
          }
        };
        const environment = pass.resolvedEnv.name;

        // Iteration-major under `--repeat`: the whole selection once, then
        // again, so a failure that depends on what ran before it meets the
        // same neighbours on every pass. `executionIndex` numbers the
        // boundary lines across every pass (1..total), not per pass.
        if (hasPickles && !beforeAllFailed) {
          for (let iteration = 0; iteration < repeat; iteration += 1) {
          for (const [pickleIndex, { feature, pickle }] of flatPickles.entries()) {
            const executionIndex = (passIndex * repeat + iteration) * flatPickles.length + pickleIndex;
            const line = pickle.location?.line ?? 0;
            // This pickle's own boundary line, right before its execution
            // actually begins.
            writeScenarioBoundary(progress, {
              index: executionIndex + 1,
              total: flatPickles.length * repeat * passes.length,
              relativeFeaturePath: feature.relativePath,
              line,
              name: roleOf(feature.relativePath, line, environment) === "control" ? `${pickle.name}  (control)` : pickle.name,
            });
            await execute(feature, pickle);
          }
          }
          // A control whose Then failed runs again, in the same pass and the
          // same world, until it has broken the same claim at the same line
          // `--proof-runs` times or a run disagrees. One round at a time, so a cell
          // stops at the first run that disagrees.
          for (;;) {
            const due = flatPickles.filter(({ feature, pickle }) => needsProof(feature.relativePath, pickle.location?.line ?? 0, environment));
            if (due.length === 0) break;
            for (const { feature, pickle } of due) {
              const line = pickle.location?.line ?? 0;
              writeProofRunBoundary(progress, {
                relativeFeaturePath: feature.relativePath,
                line,
                name: pickle.name,
                environment,
                run: (cellOutcomes.get(cellKey(feature.relativePath, line, environment))?.length ?? 0) + 1,
                of: proofRuns,
              });
              await execute(feature, pickle);
            }
          }
        }

        // AfterAll is attempted whether or not BeforeAll failed, and whether
        // or not any pickle actually passed — the only thing that suppresses it is
        // `!hasPickles`, already excluded above. Every registration is
        // attempted regardless of an earlier one's own failure (unlike
        // BeforeAll) — same "teardown always runs, in full" convention as
        // src/run/run-scenario.ts's own After-hook loop.
        if (hasPickles && world !== "failed") {
          for (const hook of afterAllHooks) {
            const ok = await runOneRunHook(hook, "AfterAll", pass.resolvedEnv.name);
            if (!ok) {
              passPassed = false;
            }
          }
        }

        // `"process"`-scope fixture teardown — once, after every scenario in
        // this invocation has finished, after
        // AfterAll (a `"process"`-scope fixture is nukadoko's own machinery,
        // not a compat hook's teardown target, so it has no ordering promise
        // relative to AfterAll beyond "after every scenario"). Never changes
        // `allPassed` — a teardown failure must not turn an otherwise-green
        // run red for a reason unrelated to the acceptance criteria, the same
        // rule scenario-scope teardown follows — and, unlike a scenario-scope
        // failure, has no single `ScenarioRecord` of its own to land on (this
        // process-scope cache spans every scenario in the invocation, not
        // one), so it is announced on stderr only. That line is the fixture's
        // own text, with no scenario record to redact it first.
        processOutcome = passPassed ? "passed" : "failed";
        await tearDownProcessFixtures();
        if (started !== null) {
          processSignal.setProcessCleanup(null);
          await stopWorld(started);
        }
        restoreEnv();
        if (!passPassed) allPassed = false;
      }

      await runOtherWorlds();
      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(rootDir, config.stateDir, runId, scenariosWritten),
        { total: scenariosWritten, passed: scenariosPassed },
        failedScenarios,
        repeatTally.list(),
        end,
      );

      return end.exitCode;
    } finally {
      restoreAllureRuntime();
    }
  } catch (error) {
    // runCli turns the throw into an unexpected-error, exit 1
    // (`failInShape`). The walk ends with that same finding first, so it
    // releases its lock and a `nuka step` waiting on it reports the error
    // instead of a walk that looks alive until the process is gone.
    walk?.end({ how: "error", exit_code: FAILED_EXIT_CODE, findings: [{ ...refusalOf(error, "unexpected-error", "run"), severity: "error" }] });
    throw error;
  } finally {
    await prepared?.cleanup();
    processSignal?.stop();
  }
}
