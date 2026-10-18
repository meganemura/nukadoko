#!/usr/bin/env node
import { formatFinding, warningSink, withoutWarningPrefix, type Finding } from "../finding/finding.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkBindings } from "../check/binding-check.js";
import { declaresDoneCallback, RUN_HOOK_ARG_COUNT } from "../check/done-callback.js";
import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { formatVocabularyError } from "../discover/format-vocabulary-error.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { emitterTargets } from "../config/emitter-targets.js";
import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { createTraceVersionWarner } from "../context/trace-actions.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { DEFAULT_ENVIRONMENT_NAME, resolveEnvironment } from "../environment/resolve-environment.js";
import { probeVersion } from "../environment/probe-version.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import { createAllureEmitter, type AllureEmitter } from "../report/allure/emitter.js";
import { runExportsManifestPath } from "../record/run-exports.js";
import { hookDisplayTitle } from "../record/scenario-record.js";
import { buildStepBindings, type StepBinding } from "./match-step.js";
import { probeGitState } from "./probe-git.js";
import { createStepProgressLogger } from "./progress-log.js";
import {
  doneCallbackMessage,
  HEARTBEAT_TICK_CAP,
  pendingOrSkippedMessage,
  runScenario,
  runWithTimeout,
  type StepFinishedInfo,
  type StepHeartbeatInfo,
} from "./run-scenario.js";
import { installProcessSignalHandlers, runOnce, type ProcessSignal } from "./process-signal.js";
import { selectPickles } from "./select-pickles.js";
import { divertProcessStdoutToStderr } from "./step-stdout.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { fixtureTeardownWarning, versionProbeWarning } from "../secrets/redact.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { serializeWorkerEnvelope, type WorkerEnvelope } from "./worker-protocol.js";

// Responsibility: one `nuka run --concurrency <n>` worker's own process
// entry point (src/run/worker-protocol.ts's own argv/envelope contract;
// spawned by src/run/spawn-run-worker.ts, never invoked directly). Runs its
// own feature-file list through exactly the same serial engine
// (src/run/run-scenario.ts's `runScenario`) src/cli/run.ts uses at
// `--concurrency 1` — the flag changes how many processes run scenarios,
// never how one scenario runs.
//
// This file re-derives config/vocabulary/bindings/environment/secrets from
// `rootDir` rather than receiving them from the parent, because none of
// them can cross a process boundary: bindings and the fixture graph both
// close over functions a step file defined, and a fixture value is a plain
// JS object with no representation on the wire. Re-deriving costs one
// config load and one discovery pass per worker, milliseconds each — far
// cheaper than inventing a serialization format for something that
// structurally cannot serialize. This is also why this worker skips the
// checks src/cli/run.ts already ran once, before spawning any worker at
// all, project-wide rather than scoped to this worker's own file slice:
// `from`/fixture-usage/fixture-definition validation and Before/After hook
// tag-expression validation. Redoing them here, scoped only to this
// worker's own files, would be strictly weaker than what the parent already
// confirmed for every file in the run.
//
// What a worker owns that the parent does not: its own `"process"`-scope
// fixture cache and its own BeforeAll/AfterAll run once per worker, because
// a worker is a process (docs/spec.md "Fixtures", "Scenarios (the scripted
// path)") — this is a deliberate difference from `--concurrency 1`, where
// the same two things are properties of the one process running everything,
// never a difference this file introduces on its own. Same for its own
// Allure emitter: this worker writes every result file its own scenarios
// produce, but never calls `begin()` (that sweeps the whole results
// directory and is the parent's job, once, before any worker starts) and
// never touches the messages stream at all (that emitter needs one
// well-formed stream for the whole invocation, so only the parent, which
// sees every worker's records, holds it).
//
// Every line this worker writes to its own stdout is a `WorkerEnvelope`
// (src/run/worker-protocol.ts's own header explains why, and why nothing
// meaningful goes to this process's real stderr instead). Project code
// that writes to `process.stdout` reaches this process's stderr instead
// (src/run/step-stdout.ts), which the parent relays raw. `note` and
// `notes`, below, take every warning a helper would otherwise write
// straight to stderr at `--concurrency 1` (a version-probe warning, an
// Allure emitter setup failure, a BeforeAll/AfterAll failure, a fixture
// teardown failure). Each becomes a `"note"` envelope holding one finding
// in its text grammar. A probe failure and a teardown failure are the
// caller's own text and can carry a loaded secret, so those two notes are
// redacted before they are written. The parent parses each note back into
// its finding and reports it as the serial path does.

const [rootDirArg, runIdArg, envArg0, quietRawArg, featureListPathArg, repeatRawArg] = process.argv.slice(2);

if (
  rootDirArg === undefined ||
  runIdArg === undefined ||
  envArg0 === undefined ||
  quietRawArg === undefined ||
  featureListPathArg === undefined ||
  repeatRawArg === undefined ||
  !/^[1-9][0-9]*$/.test(repeatRawArg)
) {
  process.exit(1);
}

// Re-bound to `string`-typed consts (never `string | undefined`) right in
// this narrowed scope: a nested function below (`main`, `readFeatureList`)
// closing over the original destructured names would otherwise see their
// *declared* type, not this scope's narrowed one — TypeScript's own control
// flow analysis does not follow a `const` into a closure defined after it.
const rootDir: string = rootDirArg;
const runId: string = runIdArg;
const featureListPath: string = featureListPathArg;
const env = envArg0 === "" ? null : envArg0;
const quiet = quietRawArg === "1";
const repeat: number = Number(repeatRawArg);

const envelopeStdout = divertProcessStdoutToStderr();
const parentPid = process.ppid;
const ignoreStreamError = (): void => {};
const CHANNEL_CLOSED_FROM_INSIDE =
  "Code in this worker closed its IPC channel to the parent while the parent was still running " +
  "(process.disconnect()). nukadoko reads a closed channel as the parent ending, so this worker " +
  "tears its fixtures down and stops.";

function emit(envelope: WorkerEnvelope): void {
  envelopeStdout.write(serializeWorkerEnvelope(envelope));
}

// A note is a finding in its text grammar, so the parent reads it back
// with the same parser and reports it with its code, as the serial path
// does.
function note(finding: Finding): void {
  emit({ kind: "note", text: formatFinding(finding).replace(/\n$/, "") });
}

function notes(code: string): WritableSink {
  return warningSink(code, note);
}

/** Reads `featureListPath` — one repo-relative `.feature` path per line, in
 * the order this worker must run them (blank lines skipped: `writeFile`
 * with a trailing newline is the common case, and a stray blank line here
 * would otherwise resolve to a spurious `selectPickles` call against
 * `rootDir` itself). */
function readFeatureList(): string[] {
  return readFileSync(featureListPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const config = await loadConfig(rootDir);
  const resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);

  const { vocabulary, compatParameterTypes, instantiateCompatWorld, compatHooks, compatRunHooks, defaultTimeoutMs } =
    await discoverSteps(rootDir, config.featuresDir);

  const bindings: readonly StepBinding[] = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  const { patterns } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  const fixtureGraph = buildFixtureGraph(config);

  const relativeFilePaths = readFeatureList();
  const flatPickles = relativeFilePaths.flatMap((relativePath) => {
    const selected = selectPickles(rootDir, relativePath);
    return selected.features.flatMap((feature) => feature.pickles.map((pickle) => ({ feature, pickle })));
  });
  // Same gate src/cli/run.ts applies at `--concurrency 1`: a file with no
  // scenario at all (a Background-only feature, a real but unusual case)
  // must not trigger this worker's own BeforeAll/AfterAll or Allure
  // emitter — there is nothing here for either to prepare or tear down.
  const hasPickles = flatPickles.length > 0;

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
      notes("version-probe-failed").write(versionProbeWarning(resolvedEnv.name, probeResult.reason, secrets) + "\n");
    }
  }

  const git = await probeGitState(rootDir);
  const onUnknownTraceVersion = createTraceVersionWarner(notes("trace-version-unknown"));

  const runConfig = { ...config, baseURL: resolvedEnv.baseURL };

  const allureResultsDirRel = emitterTargets(config).allureResultsDir;

  let allureEmitter: AllureEmitter | null = null;
  if (hasPickles && allureResultsDirRel !== null) {
    try {
      allureEmitter = createAllureEmitter({
        resultsDir: path.resolve(rootDir, allureResultsDirRel),
        rootDir,
        exportsManifestPath: runExportsManifestPath(rootDir, config.stateDir, runId),
        environment: resolvedEnv.name,
        targetVersion,
        secrets,
        stderr: notes("emitter-failed"),
        heartbeatCap: HEARTBEAT_TICK_CAP,
      });
      // Never `.begin()` here — see this file's own header.
    } catch (error) {
      allureEmitter = null;
      notes("emitter-failed").write(`allure emitter setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const runOneRunHook = async (
    hook: (typeof compatRunHooks)[number],
    label: "BeforeAll" | "AfterAll",
  ): Promise<boolean> => {
    const title = hookDisplayTitle(label, hook.name);
    try {
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
      note({ severity: "failed", code: "hook-failed", message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const restoreAllureRuntime = registerAllureRuntime();
  let allPassed = true;
  let processSignal: ProcessSignal | undefined;
  // The IPC channel closes when the parent is gone (spawn-run-worker.ts).
  // Nothing will forward a signal any more, so it counts as the first one.
  // After a forwarded signal it is no signal at all: the parent was killed
  // while this worker tore down, and that teardown must finish.
  //
  // With the parent gone, every write to stdout or stderr fails with EPIPE,
  // and an unhandled stream error would end this worker in the middle of
  // its teardown. The listeners go on first, before any write below and on
  // the forwarded-signal path too, since that teardown is still running.
  //
  // Project code can close the channel too, with process.disconnect(). The
  // parent is then still this worker's parent, so the line below says why
  // the worker stops. The parent's death reparents this worker, so nothing
  // is written then. The kernel can deliver the channel's end a moment
  // before it reparents; the listeners make that write harmless.
  const onParentGone = (): void => {
    process.stdout.on("error", ignoreStreamError);
    process.stderr.on("error", ignoreStreamError);
    if (processSignal?.interrupted !== false) return;
    if (process.ppid === parentPid) note({ severity: "failed", code: "run-incomplete", message: CHANNEL_CLOSED_FROM_INSIDE });
    processSignal.trigger("SIGHUP");
  };
  try {
    const fixtureProcessCache = createFixtureCache();
    let processOutcome: FixtureOutcome = "failed";
    processSignal = installProcessSignalHandlers();
    process.once("disconnect", onParentGone);
    if (!process.connected) onParentGone();
    const tearDownProcessFixtures = runOnce(async () => {
      const outcome = processSignal?.interrupted === true ? "failed" : processOutcome;
      const processFixtureTeardownErrors = await teardownFixtureCache(fixtureProcessCache, outcome);
      for (const teardownError of processFixtureTeardownErrors) {
        notes("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets) + "\n");
      }
    });
    processSignal.setProcessCleanup(tearDownProcessFixtures);

    const beforeAllHooks = compatRunHooks.filter((hook) => hook.type === "beforeAll");
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
          break;
        }
      }
    }

    if (hasPickles && !beforeAllFailed) {
      // Iteration-major, the same order src/cli/run.ts's own serial loop
      // uses under `--repeat`: this worker's whole list once, then again.
      for (let iteration = 0; iteration < repeat; iteration += 1) {
      for (const { feature, pickle } of flatPickles) {
        // Before anything this pickle does, so the parent's log names what
        // is running rather than what last finished.
        emit({
          kind: "scenario-started",
          feature: feature.relativePath,
          line: pickle.location?.line ?? 0,
          name: pickle.name,
        });
        const stepLines: string[] = [];
        const onStepEnd = createStepProgressLogger(
          {
            write(chunk: string): boolean {
              stepLines.push(...(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk).split("\n"));
              return true;
            },
          },
          { stateDir: config.stateDir, runId, quiet },
        );

        allureEmitter?.beginScenario({
          pickle,
          gherkinDocument: feature.gherkinDocument,
          relativeFeaturePath: feature.relativePath,
          startedAt: new Date(),
        });

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
            notes("world-setup-failed").write(`${message}\n`);
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

        const teardownNotes = (record.teardown_errors ?? []).map((teardownError) =>
          formatFinding({
            severity: "warning",
            code: "fixture-teardown-failed",
            message: withoutWarningPrefix(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets)),
          }).replace(/\n$/, ""),
        );
        emit({ kind: "scenario", record, stepLines, notes: teardownNotes });

        allureEmitter?.endScenario({
          record,
          gherkinDocument: feature.gherkinDocument,
          pickle,
          relativeFeaturePath: feature.relativePath,
        });

        if (record.status !== "passed") {
          allPassed = false;
        }
      }
      }
    }

    if (hasPickles) {
      for (const hook of afterAllHooks) {
        const ok = await runOneRunHook(hook, "AfterAll");
        if (!ok) {
          allPassed = false;
        }
      }
    }

    processOutcome = allPassed ? "passed" : "failed";
    await tearDownProcessFixtures();
  } finally {
    process.off("disconnect", onParentGone);
    // Closed, not unref'd: a `message` listener that project code adds
    // refs the channel again, and an open channel keeps this process alive
    // after its last scenario, with the parent waiting on it.
    if (process.connected) process.disconnect?.();
    processSignal?.stop();
    restoreAllureRuntime();
  }

  process.exitCode = allPassed ? 0 : 1;
}

try {
  await main();
} catch (error) {
  note({ severity: "error", code: "unexpected-error", message: formatVocabularyError(error) });
  process.exitCode = 1;
}
