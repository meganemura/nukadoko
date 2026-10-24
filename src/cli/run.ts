import { rmdirSync } from "node:fs";
import path from "node:path";
import { PickleStepType } from "@cucumber/messages";
import { analyzeRunSelectionKeepingSteps } from "../check/analyze.js";
import { checkBindings } from "../check/binding-check.js";
import { declaresDoneCallback, RUN_HOOK_ARG_COUNT } from "../check/done-callback.js";
import { matchPickleStepText } from "../check/feature-check.js";
import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig, resolveConfigFileName } from "../config/load-config.js";
import { loadProgram, PROGRAM_FILE_NAME } from "../config/load-program.js";
import { placeholderRefusal } from "../program/placeholders.js";
import { createWorldStarter, type StartedWorld, type WorldStep } from "../program/world.js";
import { applyWorldEnv } from "../program/world-view.js";
import { loadEnvFiles } from "../context/env.js";
import { createTraceVersionWarner } from "../context/trace-actions.js";
import { discoverSteps, type DiscoveryResult } from "../discover/discover-steps.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
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
  writeRepeatTallies,
  createRepeatTally,
  formatRerunCommand,
  type RunConditions,
} from "../run/progress-log.js";
import { foldVerdicts } from "../run/verdicts.js";
import type { SecretSet } from "../secrets/types.js";
import { shellWord } from "../shell/shell-word.js";
import { exitCodeForSignal, installProcessSignalHandlers, runOnce, type ProcessSignal } from "../run/process-signal.js";
import { generateRunId } from "../run/run-id.js";
import { findRepeatedScenarioPrefixes } from "../run/repeated-prefix.js";
import { renderRunSummary, writeRunSummaryFiles } from "../run/run-summary.js";
import { buildRunScenario, gherkinStepLines, pickleStepLines } from "../run/run-document.js";
import { RUN_FILE_DIRS, relativeToRun, runRelativeDir, stepRecordRelativeDir } from "../record/state-layout.js";
import { readStepRecordsForScenario } from "../report/step-records.js";
import { readOwnVersion } from "../version.js";
import { writeRunSources } from "../record/run-sources.js";
import { resolveProjectName } from "../report/allure/identity.js";
import {
  countScenarios,
  runResultRelativePath,
  writeRunResult,
  type RunCriteria,
  type RunFields,
  type RunScenario,
  type RunSince,
  type RunWorld,
} from "../record/run-result.js";
import { compareSince, scenarioKey, sinceStepFiles, type SinceComparison } from "../run/criteria-since.js";
import { resolveSince, SinceGitError } from "../run/git-since.js";
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
import { fixtureTeardownWarning, redactString, versionProbeWarning } from "../secrets/redact.js";
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
import { RefusalError, formatEnvelope, refuse, withHint, type Hint } from "./refusal.js";
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
interface Condition {
  readonly resolvedEnv: ResolvedEnvironment;
  /** The name `--env` gave, or null when the run named no environment and
   * ran under the default one. */
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
  /** `--env`, in the order given; empty for the `default` environment.
   * Each selected scenario runs once per environment, in this order. */
  envs: readonly string[];
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
  /** `--since <ref>`: compare each scenario's criteria, and each step file
   * it bound to, with the commit `ref` names, and report what moved. It
   * reports only; the exit code is unchanged. `undefined` without it. */
  since?: string;
  /** `$GITHUB_STEP_SUMMARY` as the CLI read it, `undefined` when unset or
   * empty. Passed in rather than read here so a test decides it. */
  stepSummaryPath: string | undefined;
  stdout: WritableSink;
  stderr: WritableSink;
}

/** The step records row, when the run wrote a scenario. Scenarios have no
 * directory of their own to name: run.json holds them. */
function stepsLocation(
  stateDir: string,
  runId: string,
  scenariosWritten: number,
  stepRecordsWritten: number,
): Array<{ label: string; relativePath: string; kind: "dir" | "file"; count?: number }> {
  return [
    ...(scenariosWritten > 0
      ? [{ label: "steps", relativePath: path.join(runRelativeDir(stateDir, runId), RUN_FILE_DIRS.steps), kind: "dir" as const, count: stepRecordsWritten }]
      : []),
  ];
}

export async function runRun(options: RunRunOptions): Promise<number> {
  const { rootDir, envs, concurrency, repeat, stepSummaryPath, stderr } = options;
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
  // Resolved once, before anything runs: a ref that names nothing, or a
  // project outside git, has nothing to compare against, and a run that
  // reported every scenario `new` would claim a comparison it did not make.
  let since: { ref: string; commit: string } | undefined;
  if (options.since !== undefined) {
    const resolved = await resolveSince(rootDir, options.since);
    if ("problem" in resolved) {
      if (resolved.problem === "outside-git") return refused(resolved.message, "since-outside-git");
      if (resolved.problem === "git-failed") return refused(resolved.message, "since-git-failed");
      return refused(resolved.message, "since-ref-unknown", { do: "git log --oneline" });
    }
    since = { ref: options.since, commit: resolved.commit };
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

  // One environment twice would run every scenario twice under the same
  // name, and its cells could not be told apart.
  const repeated = envs.filter((name, index) => envs.indexOf(name) !== index);
  if (repeated.length > 0) {
    return refused(`--env names ${[...new Set(repeated)].map((name) => `"${name}"`).join(", ")} more than once`, "invalid-value");
  }
  // A rerun line has to land in the same environment the failure came from.
  // A run that named no environment ran under `default`, and its rerun
  // names none either.
  const conditionsOf: RunConditions = {
    rerunFlags: (environment) => (envs.length === 0 ? [] : ["--env", environment]),
    named: envs.length > 1,
  };
  const rerunFlags = envs.flatMap((name) => ["--env", name]);

  let resolvedEnvs: ResolvedEnvironment[];
  try {
    resolvedEnvs =
      envs.length === 0
        ? [resolveEnvironment(config, program, DEFAULT_ENVIRONMENT_NAME, false)]
        : envs.map((name) => resolveEnvironment(config, program, name, true));
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
    // below actually needs: `selected.features` stays grouped by file for
    // sources.json, but every other use (counting,
    // the from/fixture checks, the pickle loop itself) wants one ordered
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

    // A placeholder a world has no value for is refused before any world
    // runs a command, the build a later world shares included, and before
    // an environment's version probe: `nuka check` reports the same gap,
    // and this is the same refusal under `--no-check`.
    const unfilled = placeholderRefusal(
      resolvedEnvs.flatMap((resolvedEnv) => (resolvedEnv.program === null ? [] : [{ name: resolvedEnv.name, recipe: resolvedEnv.program }])),
      programFile,
    );
    if (unfilled !== undefined) return refused(new Error(unfilled.message), "program-placeholder-unfilled", { fix: unfilled.fix });

    // Each environment is a condition of its own: its env files, the
    // secrets they hold, its version probe, and the world its pass starts
    // (in the execution phase, below).
    const conditions: Condition[] = [];
    for (const resolvedEnv of resolvedEnvs) {
      const envFiles = resolvedEnv.envFiles;
      // An env file that cannot be read is a setup problem, refused like
      // an invalid config under --no-check too: nothing has run yet, and
      // an `error` finding would read as a run that failed.
      let envVars: Record<string, string>;
      let secrets: ReturnType<typeof buildSecretSet>;
      try {
        envVars = loadEnvFiles(rootDir, envFiles);
        const classification = await classifyEnvFiles(rootDir, envFiles);
        secrets = buildSecretSet(rootDir, {
          secretSourceFiles: classification.secretSource,
          trackedFiles: classification.tracked,
          publicKeys: config.secrets.public,
          redactKeys: config.secrets.redact,
        });
      } catch (error) {
        return refused(error);
      }
      const probeResult = await probeVersion(resolvedEnv.version);
      let targetVersion: string | undefined;
      if (probeResult !== undefined) {
        if (probeResult.ok) {
          targetVersion = probeResult.version;
        } else {
          warnings("version-probe-failed").write(versionProbeWarning(resolvedEnv.name, probeResult.reason, secrets) + "\n");
        }
      }
      conditions.push({
        resolvedEnv,
        envArg: envs.length === 0 ? null : resolvedEnv.name,
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
      progress,
    });
    const worlds: RunWorld[] = [];
    // Starts the pass's world, or reports why it did not start. `null`
    // when the tree has no program file: the pass runs with no world.
    const startWorld = async (condition: Condition): Promise<StartedWorld | "failed" | null> => {
      if (condition.resolvedEnv.program === null) return null;
      const started = await worldStarter.start(condition.resolvedEnv.name, condition.resolvedEnv.program, condition.secrets);
      if (started.ok) return started;
      worlds.push(started.record());
      warn({ severity: "failed", code: "program-start-failed", message: started.message });
      return "failed";
    };
    // Stops the pass's world. Every scenario of the pass has its entry by
    // now, so the stop can find each step's lines of the program's log that
    // arrived after its record was written, and those entries say so.
    const stopWorld = async (world: StartedWorld): Promise<void> => {
      const name = world.view.name;
      const steps: WorldStep[] = runScenarios
        .filter((scenario) => scenario.environment === name)
        .flatMap((scenario) =>
          scenario.steps.flatMap((step) => {
            const slice = step.observed?.program_log;
            if (slice === undefined || slice === null || step.record === null) return [];
            return [{ traceId: slice.trace_id, lines: slice.lines, stamped: slice.stamped, dir: path.join(runDirAbsolute, step.record) }];
          }),
        );
      const { exitedEarly, late } = await world.stop(steps);
      worlds.push(world.record());
      if (late.size > 0) {
        for (const [index, scenario] of runScenarios.entries()) {
          if (scenario.environment !== name) continue;
          runScenarios[index] = {
            ...scenario,
            steps: scenario.steps.map((step) => {
              const found = step.observed?.program_log ? late.get(step.observed.program_log.trace_id) : undefined;
              return found === undefined ? step : { ...step, program_log_late: found };
            }),
          };
        }
      }
      if (exitedEarly !== null) warn({ severity: "warning", code: "program-exited", message: `world ${name}: ${exitedEarly}` });
    };
    const git = await probeGitState(rootDir);
    // Under `--since`, each selected scenario's criteria and each step
    // file's text are compared with the ref before the first scenario runs,
    // so a step that edits a file mid-run does not change what the run
    // reports about the files it started from.
    const projectRelative = (filePath: string): string => path.relative(rootDir, path.resolve(rootDir, filePath));
    const stepFiles = sinceStepFiles({
      rootDir,
      vocabulary,
      configFile: resolveConfigFileName(rootDir),
      definedFixtures: new Set(Object.keys(config.fixtures)),
    });
    let comparison: SinceComparison | undefined;
    if (since !== undefined) {
      try {
        comparison = await compareSince({
          rootDir,
          commit: since.commit,
          features: selected.features.map((feature) => ({ relativePath: feature.relativePath, source: feature.source })),
          targets: [...new Set(featureArgs.map((featureArg) => projectRelative(parseFeatureTarget(featureArg).relativePath)))],
          stepFiles: stepFiles.all,
        });
      } catch (error) {
        if (error instanceof SinceGitError) return refused(`nuka run --since ${since.ref} could not read the ref: ${error.message}`, "since-git-failed");
        throw error;
      }
    }
    const boundStepFiles = (scenario: RunScenario): string[] => {
      const files = new Set<string>();
      for (const step of scenario.steps) if (step.step !== null) for (const file of stepFiles.ofEntry(step.step)) files.add(file);
      return [...files].sort((a, b) => a.localeCompare(b));
    };
    const criteriaFor = (scenario: RunScenario): RunCriteria => {
      if (comparison === undefined) return { changed_since: null };
      const found = comparison.criteria.get(scenarioKey(scenario.feature, scenario.line));
      // Every selected pickle was compared before the run started, so a
      // scenario without criteria is a bug here, never a `new` scenario.
      if (found === undefined) throw new Error(`${scenario.feature}:${scenario.line} ran but was not compared with the --since ref`);
      return { ...found, step_files: boundStepFiles(scenario) };
    };
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
      const key = scenarioKey(feature.relativePath, pickle.location?.line ?? 0);
      pickleLines.set(key, pickleStepLines(pickle, lines));
      pickleOutcomes.set(key, pickle.steps.map((step) => step.type === PickleStepType.OUTCOME));
    }
    const stepKind = (name: string): "claim" | "run" | "compat" | null => {
      const entry = vocabulary.get(name);
      if (entry === undefined) return null;
      if (entry.kind === "compat") return "compat";
      return isClaimStep(entry.step) ? "claim" : "run";
    };
    const runScenarios: RunScenario[] = [];
    // A scenario's evidence directory is made before it runs, so its id is
    // taken on disk for every worker of the run, and most scenarios leave it
    // empty. Those are removed once the run is over, not when the scenario
    // ends: a later scenario of the same run must not draw the same id.
    const emptyEvidenceDirs: string[] = [];
    const noteRecord = (record: ScenarioRecord): void => {
      const stepRecords = readStepRecordsForScenario(rootDir, config.stateDir, record);
      for (const [stepRecordId, stepRecord] of stepRecords) {
        if (stepRecord !== null) continue;
        warn({
          severity: "warning",
          code: "step-record-unreadable",
          message: `${stepRecordRelativeDir(config.stateDir, runId, stepRecordId)}/record.json of ${record.feature}:${record.line} could not be read, so run.json has no declaration or measurement for that step`,
        });
      }
      const built = buildRunScenario(record, {
        stepRecords,
        stepLine: pickleLines.get(scenarioKey(record.feature, record.line)) ?? (() => null),
        stepName: (text) => {
          const { stepNames } = matchPickleStepText(text, patterns);
          return stepNames.length === 1 ? stepNames[0]! : null;
        },
        recordPath: (stepRecordId) => path.join(RUN_FILE_DIRS.steps, stepRecordId),
        evidenceDir: relativeToRun(config.stateDir, runId, record.evidence.dir),
        rerun: formatRerunCommand(record, conditionsOf.rerunFlags(record.environment)),
        inThen: (index) => pickleOutcomes.get(scenarioKey(record.feature, record.line))?.[index] ?? false,
        stepKind,
      });
      const entry: RunScenario = { ...built, criteria: criteriaFor(built) };
      runScenarios.push(entry);
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
    const sinceOf = (resolved: { ref: string; commit: string }, compared: SinceComparison): RunSince => {
      const files = [...new Set(runScenarios.flatMap((scenario) => scenario.criteria?.step_files ?? []))].sort((a, b) => a.localeCompare(b));
      return {
        ref: resolved.ref,
        commit: resolved.commit,
        compared: [...new Set(featureArgs.map((featureArg) => projectRelative(parseFeatureTarget(featureArg).relativePath)))],
        removed: compared.removed,
        step_files: files.map((file) => {
          const change = compared.stepFiles.get(file);
          if (change === undefined) throw new Error(`${file} was named by a scenario but not compared with the --since ref`);
          return { file, change };
        }),
      };
    };
    const finishRun = async (
      verdict: "passed" | "failed",
      failedScenarios: readonly FailedScenario[],
    ): Promise<{ summaryPath: string | null; retention: string | null; runResultWritten: boolean; exitCode: number; notRun: number; notes: readonly Finding[] }> => {
      // Every request a step was counted for gets its line before run.json
      // is written, one its step left open after it ended included. Under
      // `--concurrency` each worker has done this for its own requests.
      finalizeOpenRequests();
      // Read from the run's own scenario entries and the step records they
      // cite, which are on disk by now, so the notes reach run.json in its
      // one write, and a run another process finishes meanwhile is never
      // the one measured.
      const notes = findRepeatedScenarioPrefixes(path.join(rootDir, runRelativeDir(config.stateDir, runId)), runScenarios, selected.features);
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
      const verdicts = foldVerdicts(
        runScenarios,
        resolvedEnvs.map((resolvedEnv) => resolvedEnv.name),
        flatPickles.map(({ feature, pickle }) => ({ feature: feature.relativePath, line: pickle.location?.line ?? 0, scenario: pickle.name })),
      );
      const fields: RunFields = {
        run_id: runId,
        run_dir: runRelativeDir(config.stateDir, runId).split(path.sep).join("/"),
        started_at: invocationStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        commit: git === undefined ? null : { sha: git.commit, dirty: !git.clean },
        environments: conditions.map((condition) => ({
          name: condition.resolvedEnv.name,
          // Unlike a scenario record, run.json is not redacted as a whole,
          // and a version probe can answer with a secret value.
          target_version: condition.targetVersion === undefined ? null : redactString(condition.targetVersion, condition.secrets),
          base_url: worlds.find((world) => world.name === condition.resolvedEnv.name)?.url ?? null,
        })),
        // Each world's record is redacted with its own values already.
        worlds,
        selection,
        check: options.check ? "ran" : "skipped",
        counts: countScenarios(runScenarios, verdicts),
        scenarios: runScenarios,
        verdicts,
        since: since === undefined || comparison === undefined ? null : sinceOf(since, comparison),
      };
      let exitCode = verdict === "passed" ? 0 : 1;
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
      if (options.json) options.stdout.write(document);
      return { summaryPath, retention, runResultWritten, exitCode, notRun: fields.counts.not_run, notes };
    };
    // The text a person reads at the end, after the files are written: where
    // they are, the count, each failed scenario, the repeat tallies, and
    // what retention removed.
    const writeRunEnd = (
      locations: Parameters<typeof writeOutputLocations>[1],
      counts: { total: number; passed: number },
      failedScenarios: readonly FailedScenario[],
      tallies: Parameters<typeof writeRepeatTallies>[1],
      end: { summaryPath: string | null; retention: string | null; runResultWritten: boolean; notRun?: number; notes?: readonly Finding[] },
    ): void => {
      writeOutputLocations(progress, [...locations, ...summaryLocation(end.summaryPath, end.runResultWritten)]);
      writeRunSummary(progress, {
        total: counts.total,
        passed: counts.passed,
        failed: counts.total - counts.passed,
        ...(end.notRun !== undefined ? { notRun: end.notRun } : {}),
        durationMs: Date.now() - invocationStartedAt.getTime(),
      });
      for (const finding of [...failedScenarioFindings(failedScenarios, conditionsOf), ...(end.notes ?? [])]) {
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
      const {
        allPassed,
        scenariosWritten,
        scenariosPassed,
        stepRecordsWritten,
        failedScenarios,
        repeatTallies,
        interruptedBy,
      } = await runConcurrentPickles({
          rootDir,
          config,
          runId,
          repeat,
          runHookDo,
          conditions: conditions.map((condition) => ({
            envArg: condition.envArg,
            environment: condition.resolvedEnv.name,
            targetVersion: condition.targetVersion,
            secrets: condition.secrets,
            openWorld: async () => {
              const world = await startWorld(condition);
              if (world === null || world === "failed") return world;
              return { view: world.view, close: () => stopWorld(world) };
            },
          })),
          concurrency: effectiveConcurrency,
          selected,
          flatPickles,
          onRecord: noteRecord,
          progress,
          warn,
          stderr,
        });

      // An interrupted run prunes nothing and writes no run.json, as at
      // `--concurrency 1`, where the signal handler exits first.
      if (interruptedBy !== null) {
        writeRunEnd(stepsLocation(config.stateDir, runId, scenariosWritten, stepRecordsWritten), { total: scenariosWritten, passed: scenariosPassed }, failedScenarios, repeatTallies, { summaryPath: null, retention: null, runResultWritten: false });
        return exitCodeForSignal(interruptedBy);
      }
      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(config.stateDir, runId, scenariosWritten, stepRecordsWritten),
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

      processSignal = installProcessSignalHandlers();

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
      // next begins, so two conditions never share a moment or a fixture.
      const repeatTally = createRepeatTally();
      for (const [conditionIndex, condition] of conditions.entries()) {
        if (conditionsOf.named && hasPickles) progress.write(`environment ${condition.resolvedEnv.name}\n`);
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
            warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, condition.secrets) + "\n");
          }
        });
        processSignal.setProcessCleanup(tearDownProcessFixtures);
        // The pass's world, before BeforeAll: a hook may already talk to
        // the program. A signal from here on stops it after the fixtures.
        const world = hasPickles ? await startWorld(condition) : null;
        const started = world === null || world === "failed" ? null : world;
        const restoreEnv = started === null ? () => {} : applyWorldEnv(started.view.env);
        if (started !== null) {
          processSignal.setProcessCleanup(async () => {
            await tearDownProcessFixtures();
            await started.stop();
          });
        }
        const passEnv = started === null ? condition.envVars : { ...condition.envVars, ...started.view.env };
        const passSecrets = started === null ? condition.secrets : [...condition.secrets, ...started.view.secrets];
        let beforeAllFailed = world === "failed";
        if (beforeAllFailed) passPassed = false;
        if (hasPickles && !beforeAllFailed) {
          for (const hook of beforeAllHooks) {
            const ok = await runOneRunHook(hook, "BeforeAll", condition.resolvedEnv.name);
            if (!ok) {
              beforeAllFailed = true;
              passPassed = false;
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
        if (hasPickles && !beforeAllFailed) {
          for (let iteration = 0; iteration < repeat; iteration += 1) {
          for (const [pickleIndex, { feature, pickle }] of flatPickles.entries()) {
            const executionIndex = (conditionIndex * repeat + iteration) * flatPickles.length + pickleIndex;
            // This pickle's own boundary line, right before its execution
            // actually begins.
            writeScenarioBoundary(progress, {
              index: executionIndex + 1,
              total: flatPickles.length * repeat * conditions.length,
              relativeFeaturePath: feature.relativePath,
              line: pickle.location?.line ?? 0,
              name: pickle.name,
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
              environment: condition.resolvedEnv.name,
              policy: condition.resolvedEnv.policy,
              targetVersion: condition.targetVersion,
              env: passEnv,
              secrets: passSecrets,
              instantiateCompatWorld,
              onWorldSetupFailure: (message) => {
                warnings("world-setup-failed").write(`${message}\n`);
              },
              compatHooks,
              defaultTimeoutMs,
              onUnknownTraceVersion,
              onStepEnd,
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
              warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, condition.secrets) + "\n");
            }
            if (record.status !== "passed") {
              passPassed = false;
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
        if (hasPickles && world !== "failed") {
          for (const hook of afterAllHooks) {
            const ok = await runOneRunHook(hook, "AfterAll", condition.resolvedEnv.name);
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

      const end = await finishRun(allPassed ? "passed" : "failed", failedScenarios);
      writeRunEnd(
        stepsLocation(config.stateDir, runId, scenariosWritten, stepRecordsWritten),
        { total: scenariosWritten, passed: scenariosPassed },
        failedScenarios,
        repeatTally.list(),
        end,
      );

      return end.exitCode;
    } finally {
      restoreAllureRuntime();
    }
  } finally {
    processSignal?.stop();
  }
}
