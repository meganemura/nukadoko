import { rmdirSync } from "node:fs";
import path from "node:path";
import { analyzeRunSelectionKeepingSteps } from "../check/analyze.js";
import { checkBindings } from "../check/binding-check.js";
import { declaresDoneCallback, RUN_HOOK_ARG_COUNT } from "../check/done-callback.js";
import { matchPickleStepText } from "../check/feature-check.js";
import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { emitterTargets, messagesOutputPath } from "../config/emitter-targets.js";
import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { createTraceVersionWarner } from "../context/trace-actions.js";
import { discoverSteps, type DiscoveryResult } from "../discover/discover-steps.js";
import { resolveOathPaths } from "../feature/resolve-oaths.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { createAllureEmitter, type AllureEmitter } from "../report/allure/emitter.js";
import {
  createMessagesEmitter,
  type MessagesEmitter,
} from "../report/messages/emitter.js";
import { messagesRunOutputPath } from "../record/messages-output.js";
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
  writeRepeatTallies,
  createRepeatTally,
  formatRerunCommand,
} from "../run/progress-log.js";
import { shellWord } from "../shell/shell-word.js";
import { exitCodeForSignal, installProcessSignalHandlers, runOnce, type ProcessSignal } from "../run/process-signal.js";
import { generateRunId } from "../run/run-id.js";
import { renderRunSummary, writeRunSummaryFiles } from "../run/run-summary.js";
import { buildRunScenario, gherkinStepLines, pickleStepLines } from "../run/run-document.js";
import { readStepRecordsForScenario } from "../report/step-records.js";
import { readOwnVersion } from "../version.js";
import { runExportsManifestPath } from "../record/run-exports.js";
import {
  countScenarios,
  runResultRelativePath,
  writeRunResult,
  type RunFields,
  type RunScenario,
} from "../record/run-result.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import { applyRetention, formatRetention } from "../record/retention.js";
import {
  doneCallbackMessage,
  HEARTBEAT_TICK_CAP,
  pendingOrSkippedMessage,
  runScenario,
  runWithTimeout,
  type StepFinishedInfo,
  type StepHeartbeatInfo,
} from "../run/run-scenario.js";
import { DirectoryTargetLineError, parseFeatureTarget, selectPickles } from "../run/select-pickles.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { fixtureTeardownWarning, versionProbeWarning } from "../secrets/redact.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../fixture/validate-fixtures.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { asFinding, writeCheckIssueLines } from "./check.js";
import { formatFinding, warningSink, type Finding } from "../finding/finding.js";
import { checkCodeFix } from "../check/codes.js";
import type { RefusalCode } from "./refusal-codes.js";
import { RefusalError, formatEnvelope, refuse, withHint, type Hint } from "./refusal.js";
import { stepRecordPath } from "../run/progress-log.js";
import type { WritableSink } from "../sink/writable-sink.js";

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
// The Allure emitter is built and `begin()`-ed once, after `hasPickles` is
// known, for the same reason BeforeAll and AfterAll are: a run that selects
// nothing has nothing for the emitter to measure, so it never creates
// `allure-results/`. Construction and `begin()` share one try/catch even
// though the emitter's other methods already carry their own
// (src/report/allure/emitter.ts). `createAllureEmitter` creates `resultsDir`
// synchronously (src/report/allure/writer.ts's `createAtomicWriter`), which
// can throw before the emitter's own safety net exists. A failure here is a
// warning on stderr, never a run failure: measurement must not break
// execution. `allureEmitter` stays null, and every later
// `beginScenario`, `emitStep`, and `endScenario` call is skipped for the
// rest of the run.
//
// A pickle's `emitStep` calls happen once per step, through `runScenario`'s
// `onStepFinished`, never gated on `--quiet`, before that pickle's
// `stdout.write`. Each call maps that one step, buffers the result, and
// writes a disposable progress snapshot (src/report/allure/emitter.ts). The
// one real Allure test for the scenario reaches disk only at `endScenario`,
// after the `stdout.write`: stdout's one-line-per-scenario contract must
// not be disturbed by an emit failure, and none of these methods throws.
// `endScenario` writes that test result, maps hooks into fixtures, and
// deletes the progress snapshots. `record.status`, the run's exit code, and
// stdout's content stay untouched by any of this.
//
// The messages emitter is built and `begin()`-ed right after the Allure
// emitter: the same `hasPickles` gate, the same try/catch around
// construction and `begin()`, and the same stderr-warning-only failure
// handling (src/report/messages/emitter.ts). `emitScenario` sits immediately
// after the Allure emitter's `endScenario`, both after that scenario's
// `stdout.write`. `end(allPassed)` runs after AfterAll, immediately before
// this function returns. That is the one place `allPassed` has absorbed
// every BeforeAll and AfterAll failure, so `testRunFinished.success` equals
// this run's exit code. That stream is the only channel for a run-scope
// hook's failure, since neither hook has a record of its own.
//
// Output-file semantics: one `nuka run` invocation is one stream. Its real
// file is unique to this invocation, named from `runId`
// (src/report/messages/emitter.ts's `messagesRunOutputPath`). `begin()`
// truncates that file, never the configured `messagesOutputRel` path.
// Appending would produce a second `testRunStarted` in what must read back
// as a single message stream, and a second concurrent invocation must not
// share this invocation's file. A directory target folds every `.feature`
// file into this same stream, with `begin()` called once, and it is still
// one invocation and one file. The configured path changes only in `end()`,
// replaced atomically with a copy of this invocation's finished stream, so
// a later sequential `nuka run` still leaves that path holding the newest
// run.
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
// A `:line` target that selects fewer scenarios than its file holds writes
// one stderr line after `selectPickles`, naming that the run is partial and that its run summary covers only the
// selected scenarios, so a summary pasted onto a pull request is not read
// as the whole feature (docs/spec.md "Scenarios (the scripted path)"). stdout is untouched: its
// one-record-per-line contract is read by machines, and this notice is not
// part of it.
//
// Progress lines (src/run/progress-log.ts) go to stderr, never stdout.
// stdout's one-JSON-record-per-scenario contract stays a machine contract.
// `onStepProgress` is built once and threaded into every `runScenario`
// call, and is undefined under `--quiet`. `--quiet` suppresses only the
// step and scenario boundary lines. `writeOutputLocations` and
// `writeRunSummary` near the return are unconditional: each is written
// once, and naming where output landed is not what that flag is for. The
// progress has no TTY check. A CI log wants the same progress. The records
// on stdout are written only under `--records`, and under `--json` none of
// these lines is written at all (see `runRun`).
//
// The Markdown run summary (src/run/run-summary.ts) is the reader-facing
// counterpart of those stderr lines. Every written record is noted as it is
// written, by this file at concurrency 1 and through `onRecord` above it,
// and the summary is written once, after AfterAll and process fixture
// teardown, so its verdict is the exit code's. It is written before the
// output locations so that list can name it, and before run.json,
// which stays the run's last write.
//
// `--concurrency` above 1 diverts to src/run/run-concurrent.ts, in one
// branch after every setup-phase check (bindings, from, fixtures, tag
// expressions) and before `registerAllureRuntime`. Those checks still run
// once, project-wide, so a higher concurrency refuses the same broken
// project concurrency 1 would, before spawning a worker. A target that
// names one feature file drops concurrency back to 1 instead of refusing
// (the comment above that branch says why). From there, the execution-phase code below is what a concurrency-1
// run always takes.

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

export interface RunRunOptions {
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  notices?: readonly Finding[];
  rootDir: string;
  /** `<feature[:line]>` or directory targets. None means `featuresDir`,
   * the same default `nuka check` walks (without `additionalFeatureDirs`,
   * which only `nuka check` and `nuka tend` read). */
  featureArgs: readonly string[];
  /** `false` under `--no-check`: skip the static check this run otherwise
   * performs over its own selection before it executes anything. */
  check: boolean;
  env: string | null;
  /** Suppresses the per-step and per-scenario progress lines — the
   * output-location and summary lines at the
   * end of a run are written either way; see this file's own header. */
  quiet: boolean;
  /** `--records`: write each scenario's run.json entry to stdout, one per
   * line, as the scenario finishes.
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
  /** `--summary <path>`: one more copy of the run summary, resolved against
   * `rootDir`, for a CI step that posts it as a pull request comment.
   * `null` without the flag; the copy in the run directory is written
   * either way. */
  summaryPath: string | null;
  /** `$GITHUB_STEP_SUMMARY` as the CLI read it, `undefined` when unset or
   * empty. Passed in rather than read here so a test decides it. */
  stepSummaryPath: string | undefined;
  stdout: WritableSink;
  stderr: WritableSink;
}

/** The output-location rows for the emitters that are on; a row for one
 * that is off would name a path nothing wrote. The messages row names this
 * run's own suffixed file, which a concurrent invocation cannot replace. */
function exportLocations(
  allureResultsDirRel: string | null,
  messagesOutputRel: string | null,
  runId: string,
): Array<{ label: string; relativePath: string; kind: "dir" | "file" }> {
  return [
    ...(allureResultsDirRel === null ? [] : [{ label: "allure", relativePath: allureResultsDirRel, kind: "dir" as const }]),
    ...(messagesOutputRel === null
      ? []
      : [{ label: "messages", relativePath: messagesRunOutputPath(messagesOutputRel, runId), kind: "file" as const }]),
  ];
}

/** The step records row, when the run wrote a scenario, then the export
 * rows. Scenarios have no directory of their own to name: run.json holds
 * them. */
function stepsLocation(
  stateDir: string,
  scenariosWritten: number,
  stepRecordsWritten: number,
  exports: ReturnType<typeof exportLocations>,
): Array<{ label: string; relativePath: string; kind: "dir" | "file"; count?: number }> {
  return [
    ...(scenariosWritten > 0
      ? [{ label: "steps", relativePath: path.join(stateDir, "records", "steps"), kind: "dir" as const, count: stepRecordsWritten }]
      : []),
    ...exports,
  ];
}

export async function runRun(options: RunRunOptions): Promise<number> {
  const { rootDir, env, quiet, concurrency, repeat, summaryPath, stepSummaryPath, stderr } = options;
  const notices = options.notices ?? [];
  const refused = (error: unknown, code: RefusalCode = "unexpected-error", hint?: Hint, before: readonly Finding[] = []): number =>
    refuse({ json: options.json, stdout: options.stdout, stderr, command: "run" }, error, code, hint, [...notices, ...before]);
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
  const warn = (finding: Finding): void => {
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

  // This whole invocation's own start — read
  // again just before the summary line is written, near this function's own
  // `return`, so that line's own elapsed time covers the whole invocation
  // (config load and discovery included), not just the pickle loop.
  const invocationStartedAt = new Date();

  // --- Setup phase: any failure here writes nothing. ---
  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    return refused(error);
  }
  const featureArgs = options.featureArgs.length === 0 ? [config.featuresDir] : options.featureArgs;

  // A rerun line has to land in the same environment the failure came from.
  const rerunFlags = env === null ? [] : ["--env", env];

  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    return refused(error);
  }

  // Installed only for the serial execution path, once that path's process
  // cache exists. A signal before that still takes the default action:
  // nothing has been built. `stop()` in the `finally` below removes it
  // on a normal return.
  let processSignal: ProcessSignal | undefined;
  try {
    const select = (): ReturnType<typeof selectPickles> | { refused: unknown } => {
      try {
        const oaths = resolveOathPaths(rootDir, config.oaths);
        return selectPickles(rootDir, featureArgs, oaths.files, oaths.directories);
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
        analysis = await analyzeRunSelectionKeepingSteps(rootDir, selected.features);
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
          { fix: "Correct each error the findings name, or pass --no-check to run anyway.", do: ["nuka check", ...options.featureArgs.map(shellWord)].join(" ") },
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
    // below actually needs: `selected.
    // features` stays grouped by file for the messages emitter's own
    // `begin()` call (its own site below), but every other use — counting,
    // the from/fixture checks, the pickle loop itself — wants one ordered
    // sequence across every file, each pickle still paired with *its own*
    // feature's `relativePath`/`gherkinDocument`, never a stray shared one.
    const flatPickles = selected.features.flatMap((feature) =>
      feature.pickles.map((pickle) => ({ feature, pickle })),
    );

    // A `:line` target that leaves out other scenarios of its file makes
    // the run cover less than the files it names. run.json says so, and the
    // summary says so in its header, so a summary is not read as the whole
    // feature. `:line` on a directory target is refused in setup, so a
    // non-null line here always names one file.
    const lineTargets = featureArgs.filter((featureArg) => parseFeatureTarget(featureArg).line !== null);
    const selection: RunFields["selection"] =
      lineTargets.length > 0 && flatPickles.length < selected.totalPickles ? "partial" : "full";

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

    const envFiles = resolvedEnv.envFiles;
    const envVars = loadEnvFiles(rootDir, envFiles);
    const classification = await classifyEnvFiles(rootDir, envFiles);
    const secrets = buildSecretSet(rootDir, {
      secretSourceFiles: classification.secretSource,
      trackedFiles: classification.tracked,
      publicKeys: config.secrets.public,
      redactKeys: config.secrets.redact,
    });

    const probeResult = await probeVersion(resolvedEnv.version);
    let targetVersion: string | undefined;
    if (probeResult !== undefined) {
      if (probeResult.ok) {
        targetVersion = probeResult.version;
      } else {
        warnings("version-probe-failed").write(versionProbeWarning(resolvedEnv.name, probeResult.reason, secrets) + "\n");
      }
    }

    const runId = generateRunId();
    const git = await probeGitState(rootDir);
    // Each scenario's run.json entry is built when its record arrives, from
    // the step records it cites, so a `--repeat` run never holds more than
    // one scenario's step records at a time. The lines and step names come
    // from the pickle the record ran, found by its feature and line.
    const pickleLines = new Map<string, (index: number) => number | null>();
    const documentLines = new Map<string, Map<string, number>>();
    for (const { feature, pickle } of flatPickles) {
      let lines = documentLines.get(feature.relativePath);
      if (lines === undefined) {
        lines = gherkinStepLines(feature.gherkinDocument);
        documentLines.set(feature.relativePath, lines);
      }
      pickleLines.set(`${feature.relativePath}\u0000${pickle.location?.line ?? 0}`, pickleStepLines(pickle, lines));
    }
    const runScenarios: RunScenario[] = [];
    // A scenario's evidence directory is made before it runs, so its id is
    // taken on disk for every worker of the run, and most scenarios leave it
    // empty. Those are removed once the run is over, not when the scenario
    // ends: a later scenario of the same run must not draw the same id.
    const emptyEvidenceDirs: string[] = [];
    const noteRecord = (record: ScenarioRecord): void => {
      const entry = buildRunScenario(record, {
        stepRecords: readStepRecordsForScenario(rootDir, record),
        stepLine: pickleLines.get(`${record.feature}\u0000${record.line}`) ?? (() => null),
        stepName: (text) => {
          const { stepNames } = matchPickleStepText(text, patterns);
          return stepNames.length === 1 ? stepNames[0]! : null;
        },
        recordPath: (stepRecordId) => stepRecordPath(config.stateDir, stepRecordId),
        rerun: formatRerunCommand(record, rerunFlags),
      });
      runScenarios.push(entry);
      if (entry.evidence === undefined) emptyEvidenceDirs.push(path.join(rootDir, record.evidence.dir));
      stdout.write(`${JSON.stringify(entry)}\n`);
    };
    const summaryLocation = (relativePath: string | null) => [
      ...(relativePath === null ? [] : [{ label: "summary", relativePath, kind: "file" as const }]),
      ...(flatPickles.length === 0
        ? []
        : [{ label: "run", relativePath: runResultRelativePath(config.stateDir, runId), kind: "file" as const }]),
    ];

    // The end of a run, in the order each part needs the one before it.
    // Retention runs first, so run.json holds the findings it raises; the
    // run being finished counts as a run but is never removed. The document
    // is built next, the summary is rendered from it, and run.json is the
    // last write: it says the run ended (src/record/run-result.ts). A run
    // with no pickle wrote nothing and gets neither file. A failed write is
    // a warning: the exit code is the run's verdict either way. Returns the
    // root-relative path of the summary in the run directory, or `null`.
    const finishRun = async (verdict: "passed" | "failed", failedScenarios: readonly FailedScenario[]): Promise<{ summaryPath: string | null; retention: string | null }> => {
      runFindings.push(...failedScenarioFindings(failedScenarios, rerunFlags));
      for (const dir of emptyEvidenceDirs) {
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
          messagesOutputRel: messagesOutputPath(config),
          currentRun: { runId, startedAt: invocationStartedAt.getTime() },
        });
        retention = formatRetention(outcome, config.retention);
      } catch (error) {
        warn({ severity: "warning", code: "retention-failed", message: `retention failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      const fields: RunFields = {
        run_id: runId,
        started_at: invocationStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        commit: git === undefined ? null : { sha: git.commit, dirty: !git.clean },
        environment: resolvedEnv.name,
        target_version: targetVersion ?? null,
        selection,
        counts: countScenarios(runScenarios),
        scenarios: runScenarios,
      };
      const exitCode = verdict === "passed" ? 0 : 1;
      let summaryPath: string | null = null;
      if (flatPickles.length > 0) {
        const markdown = renderRunSummary(JSON.parse(formatEnvelope("run", exitCode, runFindings, fields)));
        const written = writeRunSummaryFiles(markdown, {
          rootDir,
          stateDir: config.stateDir,
          runId,
          summaryPath: options.summaryPath ?? undefined,
          stepSummaryPath,
        });
        for (const warning of written.warnings) warnings("summary-not-written").write(`${warning}\n`);
        summaryPath = written.runSummaryPath;
      }
      const document = formatEnvelope("run", exitCode, runFindings, fields);
      if (flatPickles.length > 0) {
        try {
          writeRunResult(rootDir, config.stateDir, runId, document);
        } catch (error) {
          warn({ severity: "warning", code: "run-result-not-written", message: `run.json was not written: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (options.json) options.stdout.write(document);
      return { summaryPath, retention };
    };
    // The text a person reads at the end, after the files are written: where
    // they are, the count, each failed scenario, the repeat tallies, and
    // what retention removed.
    const writeRunEnd = (
      locations: Parameters<typeof writeOutputLocations>[1],
      counts: { total: number; passed: number },
      failedScenarios: readonly FailedScenario[],
      tallies: Parameters<typeof writeRepeatTallies>[1],
      end: { summaryPath: string | null; retention: string | null },
    ): void => {
      writeOutputLocations(progress, [...locations, ...summaryLocation(end.summaryPath)]);
      writeRunSummary(progress, {
        total: counts.total,
        passed: counts.passed,
        failed: counts.total - counts.passed,
        durationMs: Date.now() - invocationStartedAt.getTime(),
      });
      for (const finding of failedScenarioFindings(failedScenarios, rerunFlags)) progress.write(formatFinding(withHint(finding)));
      writeRepeatTallies(progress, tallies);
      if (end.retention !== null) progress.write(`${end.retention}\n`);
    };
    // One instance for this whole `nuka run` invocation — passed unchanged
    // into every `runScenario` call below, so a run whose several steps
    // (across one scenario or several) each hit an unreadable trace
    // version still only ever writes the stderr warning once, not once per
    // occurrence.
    const onUnknownTraceVersion = createTraceVersionWarner(warnings("trace-version-unknown"));

    // Same "one instance, threaded unchanged into every `runScenario` call"
    // shape as `onUnknownTraceVersion` just above. Built under `--quiet` too:
    // the logger itself drops every line but a failed step's.
    const onStepEnd = createStepProgressLogger(progress, { stateDir: config.stateDir, quiet });

    // Only `baseURL` is overridden from the resolved environment, same as
    // cli/do.ts: every other config field has no per-environment counterpart.
    const runConfig = { ...config, baseURL: resolvedEnv.baseURL };

    // Runs one BeforeAll/AfterAll
    // registration, in isolation — `label` is only ever "BeforeAll" or
    // "AfterAll" here, but shares `doneCallbackMessage`/
    // `pendingOrSkippedMessage`'s own `"Hook"` kind (their wording doesn't
    // otherwise distinguish a scenario hook from a run-scope one). Every
    // failure is reported to stderr right here — the one place both loops
    // below need it — and reported back as a boolean rather than thrown, so
    // each loop decides for itself whether a failure stops the rest
    // (BeforeAll: yes: AfterAll: no — see this file's own header).
    const runOneRunHook = async (
      hook: (typeof compatRunHooks)[number],
      label: "BeforeAll" | "AfterAll",
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
        warn({ severity: "failed", code: "hook-failed", message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    };

    // Root-relative (src/config/schema.ts's own doc comment for each of
    // these two keys) — computed here, ahead of the `--concurrency`
    // branch just below, since both the parallel path (src/run/
    // run-concurrent.ts) and the unchanged path right after it need the
    // exact same resolved value for the output-location line near this
    // function's own `return`.
    const { allureResultsDir: allureResultsDirRel, messagesOutput: messagesOutputRel } = emitterTargets(config);

    // A target naming one file has nothing to distribute across more than
    // one worker, so `--concurrency` drops back to 1 with a one-line,
    // `--quiet`-proof reason (docs/spec.md "Scenarios (the scripted path)",
    // same category as the paths line), before any worker is spawned.
    let effectiveConcurrency = concurrency;
    if (effectiveConcurrency > 1 && selected.features.length <= 1) {
      effectiveConcurrency = 1;
      progress.write("--concurrency has nothing to distribute: this run selects one feature file.\n");
    }

    if (effectiveConcurrency > 1) {
      const {
        allPassed,
        scenariosWritten,
        scenariosPassed,
        stepRecordsWritten,
        messagesEmitter,
        failedScenarios,
        repeatTallies,
        interruptedBy,
      } = await runConcurrentPickles({
          rootDir,
          config: runConfig,
          runId,
          repeat,
          envArg: env,
          environment: resolvedEnv.name,
          targetVersion,
          secrets,
          quiet,
          concurrency: effectiveConcurrency,
          selected,
          flatPickles,
          allureResultsDirRel,
          messagesOutputRel,
          onRecord: noteRecord,
          progress,
          warn,
          stderr,
        });

      messagesEmitter?.end(allPassed);
      // An interrupted run prunes nothing and writes no run.json, as at
      // `--concurrency 1`, where the signal handler exits first.
      if (interruptedBy !== null) {
        writeRunEnd(stepsLocation(config.stateDir, scenariosWritten, stepRecordsWritten, exportLocations(allureResultsDirRel, messagesOutputRel, runId)), { total: scenariosWritten, passed: scenariosPassed }, failedScenarios, repeatTallies, { summaryPath: null, retention: null });
        return exitCodeForSignal(interruptedBy);
      }
      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(config.stateDir, scenariosWritten, stepRecordsWritten, flatPickles.length > 0 ? exportLocations(allureResultsDirRel, messagesOutputRel, runId) : []),
        { total: scenariosWritten, passed: scenariosPassed },
        failedScenarios,
        repeatTallies,
        end,
      );

      return allPassed ? 0 : 1;
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
      // asked for. `stepRecordsWritten` sums every step across every one of
      // those records whose own `record` is non-null.
      let scenariosWritten = 0;
      let scenariosPassed = 0;
      let stepRecordsWritten = 0;
      const failedScenarios: FailedScenario[] = [];

      // Skipped entirely for a run that selects zero pickles: no pickle
      // selected means BeforeAll/AfterAll never run —
      // `hasPickles` gates every step below, including AfterAll.
      const hasPickles = flatPickles.length > 0;

      // This whole invocation's own `"process"`-scope fixture cache — one
      // instance, shared by every `runScenario`
      // call below, so a `"process"`-scope fixture named by more than one
      // scenario is built exactly once and torn down exactly once, after
      // the pickle loop
      // (below, near AfterAll). Cheap to create even for a zero-pickle run
      // — an empty cache's own teardown is a no-op.
      const fixtureProcessCache = createFixtureCache();
      // `"failed"` until the invocation's own outcome is known. A signal
      // during a scenario reads this, or `interrupted`, and reports
      // `"failed"` because that invocation did not finish.
      let processOutcome: FixtureOutcome = "failed";
      processSignal = installProcessSignalHandlers();
      const tearDownProcessFixtures = runOnce(async () => {
        const outcome = processSignal?.interrupted === true ? "failed" : processOutcome;
        const processFixtureTeardownErrors = await teardownFixtureCache(fixtureProcessCache, outcome);
        for (const teardownError of processFixtureTeardownErrors) {
          // The line is the fixture's own text, with no scenario record to
          // redact it first.
          warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets) + "\n");
        }
      });
      processSignal.setProcessCleanup(tearDownProcessFixtures);

      // `allureResultsDirRel`/`messagesOutputRel` are computed once, above
      // the `--concurrency` branch this block sits after — the exact
      // resolved value (config default already applied, the actual write
      // destination rather than the config key itself) both this block and
      // src/run/run-concurrent.ts need for the output-location line near
      // this function's own `return`, whether or not the emitter that
      // writes there actually succeeds. `messagesOutputRel` itself feeds
      // two different things below: the emitter's own `output` (the
      // stable, config-facing path it copies its finished stream onto),
      // and, run-id-suffixed via `messagesRunOutputPath`, the row that
      // output-location line names — a concurrent second invocation can
      // replace the stable path's contents before a reader gets to it, but
      // never this run's own suffixed file (src/report/messages/
      // emitter.ts's own header).

      // See this file's own header for why this is gated on `hasPickles`,
      // why construction and
      // `begin()` are wrapped together, and why a failure here never fails
      // the run.
      let allureEmitter: AllureEmitter | null = null;
      if (hasPickles && allureResultsDirRel !== null) {
        try {
          const resultsDir = path.resolve(rootDir, allureResultsDirRel);
          allureEmitter = createAllureEmitter({
            resultsDir,
            rootDir,
            exportsManifestPath: runExportsManifestPath(rootDir, config.stateDir, runId),
            environment: resolvedEnv.name,
            targetVersion,
            secrets,
            stderr: warnings("emitter-failed"),
            // The exact same cap run-scenario.ts's own heartbeat enforces
            // per step (src/report/allure/emitter.ts's own
            // `AllureEmitterOptions.heartbeatCap` doc comment), threaded
            // through explicitly so the two can never drift apart on their
            // own.
            heartbeatCap: HEARTBEAT_TICK_CAP,
          });
          allureEmitter.begin();
        } catch (error) {
          allureEmitter = null;
          warnings("emitter-failed").write(`allure emitter setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }

      // See this file's own header for the gate, the try/catch shape, and
      // the output-file truncate semantics.
      let messagesEmitter: MessagesEmitter | null = null;
      if (hasPickles && messagesOutputRel !== null) {
        try {
          const output = path.resolve(rootDir, messagesOutputRel);
          messagesEmitter = createMessagesEmitter({
            output,
            rootDir,
            stderr: warnings("emitter-failed"),
            runId,
            exportsManifestPath: runExportsManifestPath(rootDir, config.stateDir, runId),
          });
          // One `features` entry per file `selected` carries —
          // `selected.features` is already in this
          // run's own deterministic order, so this emitter has no reordering
          // of its own to do (src/report/messages/emitter.ts's own header).
          messagesEmitter.begin({
            features: selected.features.map((feature) => ({
              relativeFeaturePath: feature.relativePath,
              gherkinDocument: feature.gherkinDocument,
              pickles: feature.pickles,
            })),
          });
        } catch (error) {
          messagesEmitter = null;
          warnings("emitter-failed").write(`messages emitter setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }

      const beforeAllHooks = compatRunHooks.filter((hook) => hook.type === "beforeAll");
      // Same LIFO convention as src/run/run-scenario.ts's own After-hook
      // loop (that file's own comment: "teardown unwinds in the opposite
      // order setup ran in") — registration order reversed, so the most
      // recently registered AfterAll runs first.
      const afterAllHooks = compatRunHooks
        .filter((hook) => hook.type === "afterAll")
        .slice()
        .reverse();

      let beforeAllFailed = false;
      if (hasPickles) {
        for (const hook of beforeAllHooks) {
          const ok = await runOneRunHook(hook, "BeforeAll");
          if (!ok) {
            beforeAllFailed = true;
            allPassed = false;
            // Stop at the first BeforeAll failure — same convention
            // as scenario-level Before.
            break;
          }
        }
      }

      // Iteration-major under `--repeat`: the whole selection once, then
      // again, so a failure that depends on what ran before it meets the
      // same neighbours on every pass. `executionIndex` numbers the
      // boundary lines across every pass (1..total), not per pass.
      const repeatTally = createRepeatTally();
      if (hasPickles && !beforeAllFailed) {
        for (let iteration = 0; iteration < repeat; iteration += 1) {
        for (const [pickleIndex, { feature, pickle }] of flatPickles.entries()) {
          const executionIndex = iteration * flatPickles.length + pickleIndex;
          // This pickle's own boundary line, right before its execution
          // actually begins.
          if (!quiet) {
            writeScenarioBoundary(progress, {
              index: executionIndex + 1,
              total: flatPickles.length * repeat,
              relativeFeaturePath: feature.relativePath,
              line: pickle.location?.line ?? 0,
              name: pickle.name,
            });
          }

          // Opens this scenario's own Allure scope right before its first
          // step can possibly run — `emitStep` below needs it to already
          // exist the moment the
          // first step finishes. `undefined` — a no-op — when this run has
          // no Allure emitter at all (setup failure or zero pickles, this
          // file's own header). `startedAt` is captured here, not read back
          // out of `record` below: this call always happens before
          // `runScenario` even starts, so it can only ever be earlier than
          // or equal to that call's own `record.started_at`, which is what
          // keeps every progress snapshot's own `start` strictly below the
          // real result's (src/report/allure/emitter.ts's own
          // `BeginScenarioInput`).
          allureEmitter?.beginScenario({
            pickle,
            gherkinDocument: feature.gherkinDocument,
            relativeFeaturePath: feature.relativePath,
            startedAt: new Date(),
          });

          // One instance per pickle, unlike `onStepEnd` above: it closes
          // over this
          // pickle's own `gherkinDocument`/`relativeFeaturePath`, which
          // `run-scenario.ts`'s own `StepFinishedInfo` does not carry (that
          // struct is per-*step*, not per-*scenario*). Built regardless of
          // `quiet` — the report's own granularity does not follow the
          // terminal's — and is itself a
          // no-op when `allureEmitter` is `null`.
          const onStepFinished: ((info: StepFinishedInfo) => void) | undefined = allureEmitter
            ? (info) => {
                allureEmitter?.emitStep({
                  ...info,
                  gherkinDocument: feature.gherkinDocument,
                  pickle,
                  relativeFeaturePath: feature.relativePath,
                  environment: resolvedEnv.name,
                  session: null,
                  targetVersion,
                  runId,
                });
              }
            : undefined;

          // Same "no-op unless there's an Allure emitter to write to" shape
          // as `onStepFinished` just above, built once per pickle for the
          // same reason: this closure needs that pickle's own
          // `gherkinDocument`/`relativeFeaturePath`, which
          // `StepHeartbeatInfo` itself does not carry.
          const onStepProgress: ((info: StepHeartbeatInfo) => void) | undefined = allureEmitter
            ? (info) => {
                allureEmitter?.emitStepProgress({
                  ...info,
                  gherkinDocument: feature.gherkinDocument,
                  pickle,
                  relativeFeaturePath: feature.relativePath,
                });
              }
            : undefined;

          const record = await runScenario({
            rootDir,
            config: runConfig,
            pickle,
            relativeFeaturePath: feature.relativePath,
            gherkinDocument: feature.gherkinDocument,
            vocabulary,
            bindings,
            patterns,
            runId,
            git,
            environment: resolvedEnv.name,
            policy: resolvedEnv.policy,
            targetVersion,
            env: envVars,
            secrets,
            instantiateCompatWorld,
            onWorldSetupFailure: (message) => {
              warnings("world-setup-failed").write(`${message}\n`);
            },
            compatHooks,
            defaultTimeoutMs,
            onUnknownTraceVersion,
            onStepEnd,
            onStepFinished,
            onStepProgress,
            fixtureGraph,
            fixtureProcessCache,
            processSignal,
          });

          // One JSON line per completed scenario record, streamed as it
          // finishes; everything else about
          // this run goes to stderr, never stdout.
          noteRecord(record);
          scenariosWritten += 1;
          if (record.status === "passed") {
            scenariosPassed += 1;
          }
          if (repeat > 1) repeatTally.note(record);
          stepRecordsWritten += record.steps.filter((step) => step.step_record_id !== null).length;
          // A `"scenario"`-scope fixture's own teardown failure — already
          // recorded on `record.teardown_
          // errors` (src/run/run-scenario.ts); announced here too, on
          // stderr, so it is never silent even though it never changes
          // `record.status` or this run's own exit code. Redacted on this
          // write as well: the record's copy is already redacted, and this
          // stderr line has to stay that way on its own.
          for (const teardownError of record.teardown_errors ?? []) {
            warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets) + "\n");
          }
          // After the stdout line, always — see this file's own header.
          // `allureEmitter` is `null` when this run selected zero pickles or
          // its own setup failed above; `endScenario` itself never throws.
          // Every one of this scenario's own steps has already had its own
          // `emitStep` call by now, each one only buffered — this call is
          // what actually writes this scenario's one Allure test result
          // (every buffered step nested inside it), maps this scenario's
          // own hooks into fixtures alongside it, and writes the scope both
          // share.
          allureEmitter?.endScenario({
            record,
            gherkinDocument: feature.gherkinDocument,
            pickle,
            relativeFeaturePath: feature.relativePath,
          });
          messagesEmitter?.emitScenario({ record, pickle });
          if (record.status !== "passed") {
            allPassed = false;
            failedScenarios.push(failedScenarioOf(record));
          }
        }
        }
      }

      // AfterAll is attempted whether or not BeforeAll failed, and whether
      // or not any pickle actually passed — the only thing that suppresses it is
      // `!hasPickles`, already excluded above. Every registration is
      // attempted regardless of an earlier one's own failure (unlike
      // BeforeAll) — same "teardown always runs, in full" convention as
      // src/run/run-scenario.ts's own After-hook loop.
      if (hasPickles) {
        for (const hook of afterAllHooks) {
          const ok = await runOneRunHook(hook, "AfterAll");
          if (!ok) {
            allPassed = false;
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
      processOutcome = allPassed ? "passed" : "failed";
      await tearDownProcessFixtures();

      // See this file's own header for why this must run here — after
      // BeforeAll/AfterAll have
      // had their chance to flip `allPassed`, immediately before the
      // `return` below that turns it into this run's own exit code.
      messagesEmitter?.end(allPassed);
      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(config.stateDir, scenariosWritten, stepRecordsWritten, hasPickles ? exportLocations(allureResultsDirRel, messagesOutputRel, runId) : []),
        { total: scenariosWritten, passed: scenariosPassed },
        failedScenarios,
        repeatTally.list(),
        end,
      );

      return allPassed ? 0 : 1;
    } finally {
      restoreAllureRuntime();
    }
  } finally {
    processSignal?.stop();
  }
}
