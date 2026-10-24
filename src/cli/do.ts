import { SCHEMA_VERSIONS } from "../record/schema-version.js";
import { readOwnVersion } from "../version.js";
import { installProcessSignalHandlers, runOnce, type ProcessSignal } from "../run/process-signal.js";
import {
  argOrigins,
  channelsOfStepRecord,
  claimArgSide,
  executeTypedStep,
  recordedChannels,
  withMeasured,
} from "../run/execute-typed-step.js";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { loadProgram, PROGRAM_FILE_NAME } from "../config/load-program.js";
import { placeholderRefusal } from "../program/placeholders.js";
import { createWorldStarter, type StartedWorld, type WorldStep } from "../program/world.js";
import { applyWorldEnv } from "../program/world-view.js";
import { createStepContext, finalizeOpenRequests, installChannelPatches, type DisposeResult } from "../context/create-context.js";
import { EnvFileUnreadableError, loadEnvFiles } from "../context/env.js";
import { evidenceMetaFields, mergeTruncated } from "../context/evidence.js";
import { collectTraceEvidence, createTraceVersionWarner } from "../context/trace-actions.js";
import { omitUsedResults } from "../context/used.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { probeVersion } from "../environment/probe-version.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  ReadOnlyEnvironmentError,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { createRecordDir, generateStepRecordId } from "../record/record-id.js";
import { readStepRecordById } from "../record/read-step-record.js";
import { doRelativeDir, stepRecordRelativeDir } from "../record/state-layout.js";
import { retentionNote } from "../record/retention.js";
import type { ArgOrigin, ErrorKind, StepRecord } from "../record/types.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact, fixtureTeardownWarning, versionProbeWarning } from "../secrets/redact.js";
import type { Step } from "../step/define-step.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../fixture/validate-fixtures.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { resolveUse, type ResolveUseSuccess } from "../step/resolve-use.js";
import { reviveStoredForm } from "../stored-form/revive.js";
import { formatFinding, warningSink } from "../finding/finding.js";
import { FAILED_EXIT_CODE, refuse, withHint } from "./refusal.js";
import { describeArgsCommand } from "./option-defaults.js";
import { assertFeaturesDirExists } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka do`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as vocabulary.ts).
// Two phases, matching docs/spec.md's "Running"/"Records" split exactly:
//
//   1. Setup — malformed --args JSON, an unknown step name, a config/
//      discovery error, an unknown `--env` name, a mutating step against a
//      `policy: "read-only"` environment, a bad `--use <record-id>` (unknown id, a non-`"passed"` step record, a step
//      record whose step names none of this step's `from` entries, or a
//      missing
//      result key), or two `--use` values filling the
//      same `from` key from two different candidate producers (the one
//      ambiguity a scenario's own
//      from-order guard would refuse that `nuka do` has no such guard to
//      catch by itself). None of these write a step record: the run never
//      started, so there is nothing to attest to (a step record for an
//      execution
//      that never began would let a nonexistent run be cited later as if it
//      had happened).
//   2. Execution — from here a step record is always written, whatever
//      happens: args schema failure, the step's own throw, and returns
//      schema failure are all `status: "failed"` with `error.message`; only
//      a step whose args and returns both validate and whose `run` doesn't
//      throw is `status: "passed"`. The setup phase's read-only refusal above
//      only ever sees the step's *declared* `mutates`, and that declaration
//      is trusted — an otherwise-"passed" run
//      that wrote in a read-only environment is no
//      longer demoted for it; `record.observed` still records what
//      happened, it just doesn't decide `status` any more. `--use`'s own
//      values, already resolved and validated in setup above, are actually
//      applied here — merged into `parsedArgs` (`--args` still wins for a
//      key it already set) and recorded into `used` through the same
//      collector `ctx.resultOf` writes into — because that collector only
//      exists once `contextHandle` does.
//
// `--env` is resolved (environment/resolve-environment.ts) right after
// config loads. The secret set is built once before the
// version probe, still at the top of the execution phase: the probe's
// failure reason is its own text and can carry a loaded secret, and the
// warning is a stderr line rather than the step record. The probe itself
// is metadata about the target, never reachable from a step's own `run`,
// and its failure or timeout never fails the run. Only `target_version`
// is omitted, with one stderr warning line.
//
// With a program file, the tree's head world is started for this one
// execution, before the step's context, and stopped after the step's
// fixtures are torn down (docs/spec.md "Program"). Its directory sits in
// the step record's own, so a failed step and the program's log are read
// side by side. A world that does not start is a refusal like the setup
// phase's: the step never ran, so no step record is written, and the
// message carries the end of the program's log.
//
// The evidence-collecting side of ctx (browser/http/trace) is created and
// disposed here, never handed to the step itself — see
// context/create-context.ts's header for why that split exists.
//
// This is also the one place a run's SecretSet is built and the one place a
// step record gets redacted:
// env is loaded and classified at the top of the execution phase against the
// *effective* envFiles (top-level + the resolved environment's own), and
// the finished step record is redacted
// once, as a whole object, before either record.json or the stdout copy is
// written from it — never twice, independently, which could let the two
// drift apart.

/** The world's directory, beside the step record: `nuka do` has one step
 * and one world, so the record directory holds both. */
const DO_WORLD_DIR_NAME = "world";

export interface RunDoOptions {
  rootDir: string;
  name: string;
  /** `--args` as given, or `null` when it was left out. */
  argsJson: string | null;
  /** `--env`'s value, or `null` when it was omitted. `null` is not the same
   * as the string `"default"`: it is what tells resolveEnvironment() not to
   * require a matching `environments` entry in nukadoko.program.ts.
   */
  env: string | null;
  /** `--use <record-id>` (repeatable), in the order given (docs/spec.md
   * "Single steps (the agent path)"): each fills whichever
   * of this step's own `from` keys that step record's step is named by. Empty
   * when `--use` was never given — the common case, and unrelated to `from`
   * being empty too (a step can have `from` entries and simply be run with
   * every key passed through `--args` instead, same as under a scenario). */
  use: readonly string[];
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runDo(options: RunDoOptions): Promise<number> {
  const { rootDir, name, argsJson, env, use, stdout, stderr } = options;
  // `do` prints a step record on stdout, never a report of its own, so a
  // refusal stays text on stderr.
  const sinks = { json: false, stdout, stderr, command: "do" };
  const warnings = (code: string): WritableSink =>
    warningSink(code, (finding) => stderr.write(formatFinding(withHint(finding))));

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
    return refuse(sinks, error, "unexpected-error");
  }

  // `env !== null` is what distinguishes "explicit --env
  // that must exist in the program file's environments" from "implicit
  // default, no such requirement"; see
  // resolve-environment.ts's header for the reasoning.
  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, program, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    return refuse(sinks, error, "unexpected-error");
  }
  // Refused before anything runs, as `nuka run` refuses it (src/cli/run.ts).
  const unfilled =
    resolvedEnv.program === null ? undefined : placeholderRefusal([{ name: resolvedEnv.name, recipe: resolvedEnv.program }], programFile);
  if (unfilled !== undefined) return refuse(sinks, new Error(unfilled.message), "program-placeholder-unfilled", { fix: unfilled.fix });

  // Installed once this execution's fixture caches exist. `stop()` in the
  // `finally` below removes it on a normal return.
  let processSignal: ProcessSignal | undefined;
  // Set once the head world runs, so the `finally` below stops it on every
  // path out, a throw included.
  let stopWorld: (() => Promise<void>) | undefined;
  // The step's slice of the program's log, once its record's `observed`
  // is read, so the world's stop can find its lines that came later. A
  // signal before then stops the world with no step to look for.
  let tracedSteps: WorldStep[] = [];

  try {
    let vocabulary;
    try {
      // Compat-origin parameter types are
      // irrelevant to `nuka do`, which only ever names one step by its
      // vocabulary key.
      const discovery = await discoverSteps(rootDir, config.featuresDir);
      ({ vocabulary } = discovery);
      // Discovery treats a missing featuresDir as an empty vocabulary, so
      // the lookup below would report "Unknown step" for a directory that
      // is not there. Same refusal `nuka steps` and `nuka describe` make.
      assertFeaturesDirExists(rootDir, config);
    } catch (error) {
      return refuse(sinks, error, "unexpected-error");
    }

    const entry = vocabulary.get(name);
    if (!entry) {
      return refuse(sinks, `Unknown step: ${name}`, "unknown-step", { do: "nuka steps" });
    }

    // `nuka do` cannot name a compat
    // step by name — a compat step has no typed contract (no args/returns
    // schema, no validated result), so there is nothing for `nuka do` to
    // validate or run in isolation (docs/spec.md "Compat steps (the migration door)").
    // This is a setup failure, not an execution one: no step record is written.
    if (entry.kind === "compat") {
      return refuse(sinks, `Step "${name}" is a compat step and has no typed contract, so nuka do cannot run it alone`, "compat-step-not-runnable");
    }

    // After the lookup, so the do line's `nuka describe <name>` names a
    // step that exists: an unknown name is refused as unknown first.
    if (argsJson === null && use.length === 0) {
      return refuse(
        sinks,
        "--args is required unless --use supplies this step's arguments",
        "step-args-invalid",
        { do: describeArgsCommand(name, "nuka do --help") },
      );
    }
    let parsedArgs: unknown;
    try {
      // `{}` when `--use` supplies the arguments: `from` injection below
      // fills that object.
      parsedArgs = JSON.parse(argsJson ?? "{}");
    } catch (error) {
      return refuse(
        sinks,
        `Invalid JSON for --args: ${error instanceof Error ? error.message : String(error)}`,
        "step-args-invalid",
        { do: describeArgsCommand(name, "nuka do --help") },
      );
    }

    // Built once, from this same vocabulary — the "Step object -> the name
    // discovery registered it under" map both `isRegisteredStep` just below
    // and `--use`'s own step-name match need, so this
    // walks `vocabulary` once rather than twice for the two questions.
    const stepNameOf = new Map<Step, string>(
      [...vocabulary.entries()].flatMap(([stepName, vocabularyEntry]) =>
        vocabularyEntry.kind === "typed" ? [[vocabularyEntry.step, stepName] as const] : [],
      ),
    );
    // The "is this Step object one discovery actually registered" predicate
    // both `from`'s own structural check just below and `ctx.resultOf`'s
    // unregistered-Step throw (wired into createStepContext further down)
    // need.
    const isRegisteredStep = registeredStepPredicate(stepNameOf.keys());

    // `from`'s own structural validation (docs/spec.md "Chaining steps":
    // "run/do refuse to execute the step at
    // all") — an unregistered upstream, an args/returns key `from` names
    // that doesn't actually exist, or an upstream that isn't even a Step.
    // Fatal like ConfigError/DuplicateStepError above: this step's execution
    // never began, so no step record is written for it.
    const fromIssues = validateStepFrom(name, entry.step, isRegisteredStep);
    if (fromIssues.length > 0) {
      return refuse(sinks, formatFromIssues(fromIssues), "step-inputs-invalid");
    }

    // The fixture-bag counterpart to the `from` structural check just above:
    // an unknown fixture name, or
    // a `run()` whose first argument isn't a plain object-destructuring
    // pattern at all, refuses this step's execution before it ever begins —
    // `nuka check` runs this exact same judgment (src/check/analyze.ts) over
    // the whole vocabulary, so a step never passes `nuka check` and then
    // fails this refusal, or the reverse. `knownFixtureNames(config)`
    // widens the closed builtin-only set to builtins ∪ `config.fixtures`.
    const fixtureGraph = buildFixtureGraph(config);
    const fixtureIssues = validateStepFixtures(name, entry.step, knownFixtureNames(config));
    if (fixtureIssues.length > 0) {
      return refuse(sinks, formatFixtureIssues(fixtureIssues), "step-inputs-invalid");
    }

    // The `config.fixtures` *definitions* themselves — the findings `nuka
    // check` reports (cycles, a `"process"`-scope fixture depending on a
    // `"scenario"`-scope one, an unowned `page` override, and a fixture
    // that names `call`), refused here before execution the same way
    // `fixtureIssues` above already is.
    const fixtureDefinitionIssues = validateFixtureDefinitions(config);
    if (fixtureDefinitionIssues.length > 0) {
      return refuse(sinks, formatFixtureDefinitionIssues(fixtureDefinitionIssues), "step-inputs-invalid");
    }

    // `--use <record-id>` (docs/spec.md "Single steps
    // (the agent path)") — resolved fully here, in setup: an unknown id, a
    // non-`"passed"` step record, a step record whose step names none of this
    // step's
    // `from` entries, or a missing result key are each a setup failure, the
    // same family as the `from` structural check just above. Only
    // validated/read here, not yet applied — applying it (and recording it
    // into `used`) has to wait for the execution phase below, where
    // `contextHandle`'s own collector
    // actually exists; this loop just fails fast before anything is written
    // if any `--use` value is bad.
    const resolvedUses: ResolveUseSuccess[] = [];
    for (const recordId of use) {
      const resolved = resolveUse(
        recordId,
        entry.step,
        stepNameOf,
        (id) => readStepRecordById(rootDir, config.stateDir, id),
        retentionNote(config.retention),
      );
      if (!resolved.ok) {
        return refuse(sinks, resolved.message, "step-inputs-invalid");
      }
      resolvedUses.push(resolved);
    }

    // A key naming
    // several candidate producers can be filled by two different `--use`
    // values that each matched a *different* one of those candidates — the
    // same ambiguity a scenario's own from-order guard (src/check/from-
    // order.ts) refuses, but `nuka do` never runs that check (it has no
    // scenario, no pickle, nothing for `checkFromOrder` to walk), so this is
    // the only place left to catch it. Every key filled by more than one
    // `resolvedUses` entry must trace back to the *same* producer step
    // (`resolved.used.step`, already the step record's own step name — every
    // key
    // one `resolveUse` call fills comes from that one step record, so it is
    // also
    // that fill's own candidate producer); two different producers for one
    // key is refused here, before anything is written. Two different
    // step records of the *same* producer filling the same key is a different,
    // pre-existing case, unrelated and unchanged here — the
    // application loop below already resolves it by taking the first one, as
    // it always has.
    const producerByKey = new Map<string, string>();
    for (const resolved of resolvedUses) {
      for (const key of Object.keys(resolved.filled)) {
        const existingProducer = producerByKey.get(key);
        if (existingProducer !== undefined && existingProducer !== resolved.used.step) {
          return refuse(sinks, `--use: key "${key}" is filled by both step "${existingProducer}" and step ` +
              `"${resolved.used.step}". These are different candidate producers for the same ` +
              `\`from\` key, and \`nuka do\` cannot tell which one should win`, "step-inputs-invalid");
        }
        producerByKey.set(key, resolved.used.step);
      }
    }

    // Read-only refusal is a setup failure, not an execution failure: the
    // step never runs, so nothing was
    // executed, so no step record is written — writing one would let a run that
    // never happened be cited later as if it had. Read-only steps
    // (`mutates: false`) are unaffected regardless of policy.
    if (resolvedEnv.policy === "read-only" && entry.step.mutates) {
      return refuse(sinks, new ReadOnlyEnvironmentError(name, resolvedEnv.name), "read-only-environment");
    }

    // --- Execution phase: a step record is always written from here on. ---
    // A `nuka do` call belongs to no run, so its record sits under `do/`,
    // apart from every run's directory (src/record/state-layout.ts).
    const { id: recordId, dir: evidenceDir } = await createRecordDir(
      path.join(rootDir, doRelativeDir(config.stateDir)),
      generateStepRecordId,
    );
    const relativeDir = stepRecordRelativeDir(config.stateDir, null, recordId);

    // env is loaded once here (ctx.env's full, merged value) and classified
    // once here (which of those same envFiles are secret sources, per git);
    // a classification failure (no git,
    // rootDir outside a repository) is itself handled inside
    // classifyEnvFiles by falling back to "everything is a secret source",
    // so it never surfaces here as a reason to fail this run. `envFiles`
    // here is the *effective* list — top-level plus the resolved
    // environment's own, later-wins
    // — not just the top-level config's. Built before the version probe
    // below: the probe's failure reason is redacted with this set, and the
    // set does not exist until classification has run.
    const envFiles = resolvedEnv.envFiles;
    // An env file that cannot be read is refused before the step runs, the
    // same way `nuka run` refuses it.
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
      if (error instanceof EnvFileUnreadableError) return refuse(sinks, error, "env-file-unreadable");
      throw error;
    }

    // The version probe is metadata about the target the tool records
    // for itself, never something a step's own `run` can see or trigger. A
    // probe that throws or times out only costs `target_version`. The step
    // still executes normally below. The reason is the probe's own text
    // (a request error can include a header the suite loaded), and this
    // warning is not the step record, so it is redacted on the write.
    const probeResult = await probeVersion(resolvedEnv.version);
    let targetVersion: string | undefined;
    if (probeResult !== undefined) {
      if (probeResult.ok) {
        targetVersion = probeResult.version;
      } else {
        warnings("version-probe-failed").write(versionProbeWarning(resolvedEnv.name, probeResult.reason, secrets) + "\n");
      }
    }

    // Installed before the world starts: a signal while it starts then
    // exits through this listener, and the exit kills what the start
    // spawned (src/program/world.ts), where the default action would end
    // this process and leave the program running.
    processSignal = installProcessSignalHandlers();
    let world: StartedWorld | null = null;
    if (resolvedEnv.program !== null) {
      // The signal's cleanup aborts the start, so a running setup or url
      // function gets its signal and the start stops what it spawned
      // before the exit.
      const startAbort = new AbortController();
      const starting = createWorldStarter({
        rootDir,
        worldDir: () => path.join(evidenceDir, DO_WORLD_DIR_NAME),
        recordPath: (absolutePath) => path.relative(rootDir, absolutePath).split(path.sep).join("/"),
        displayPath: (absolutePath) => path.relative(rootDir, absolutePath).split(path.sep).join("/"),
        progress: stderr,
      }).start(resolvedEnv.name, resolvedEnv.program, secrets, startAbort.signal);
      processSignal.setProcessCleanup(async () => {
        startAbort.abort();
        await starting;
      });
      const started = await starting;
      processSignal.setProcessCleanup(null);
      if (!started.ok) {
        if (!started.aborted) stderr.write(formatFinding(withHint({ severity: "failed", code: "program-start-failed", message: started.message })));
        return FAILED_EXIT_CODE;
      }
      world = started;
      // The program outlives the fixtures, whose teardown may still talk
      // to it, on the signal path as on the normal one.
      stopWorld = runOnce(async () => {
        const { exitedEarly, late } = await started.stop(tracedSteps);
        if (exitedEarly !== null) warnings("program-exited").write(`world ${started.view.name}: ${exitedEarly}\n`);
        for (const slice of late.values()) {
          const where = slice.file === null ? "they could not be written beside the record" : `see ${path.relative(rootDir, path.join(evidenceDir, slice.file))}`;
          const message = `world ${started.view.name}: ${slice.lines} line(s) of the program's log carry the step's trace id and arrived after the step ended; ${where}`;
          stderr.write(formatFinding(withHint({ severity: "note", code: "program-log-late", message })));
        }
      });
    }
    const restoreEnv = world === null ? () => {} : applyWorldEnv(world.view.env);
    const stepEnv = world === null ? envVars : { ...envVars, ...world.view.env };
    if (world !== null) secrets = [...secrets, ...world.view.secrets];

    const contextHandle = createStepContext({
      config,
      baseURL: world?.view.url,
      programLog: world?.view.log,
      tracePrefix: world?.view.tracePrefix,
      worldDir: world?.view.dir,
      evidenceDir,
      // The world's directory is beside the record (worldDir above), so a
      // step's evidence may not take its name.
      reservedEvidenceNames: [DO_WORLD_DIR_NAME],
      rootDir,
      env: stepEnv,
      secrets,
      // `nuka do` has no scenario, so no chain: `ctx.resultOf` always
      // returns `undefined` here (docs/spec.md "Context API"). This matches
      // createStepContext's own default when `resultOf` is omitted — spelled
      // out explicitly here so this file's own contract with `ctx.resultOf`
      // is visible in the diff, not just inherited silently.
      resultOf: () => undefined,
      // Wired in even though `resultOf` above never returns a value under
      // `do`: the unregistered-Step throw
      // is about `step` itself, not about whether a lookup would have
      // succeeded, so it must fire here exactly as it does under `nuka run`.
      isRegisteredStep,
      // `ctx.call` names a part's own `CallEntry`/error messages through
      // this — the same `stepNameOf` map `isRegisteredStep` above already
      // reads.
      stepNameOf: (step) => stepNameOf.get(step),
      // Closes the gap a part would otherwise open under a read-only
      // environment: the setup-phase check above only ever looks at the
      // named step's own declared `mutates`, so a step declared `mutates:
      // false` calling a part declared `mutates: true` was never checked
      // at all before `ctx.call` existed. Same message, same policy, only
      // the reachability path differs from that setup-phase refusal.
      refuseMutatingPart: (part) =>
        resolvedEnv.policy === "read-only" && part.mutates
          ? new ReadOnlyEnvironmentError(
              stepNameOf.get(part) ?? "a step discovery never registered",
              resolvedEnv.name,
            ).message
          : undefined,
      // `nuka do` is one execution, one trace chunk — this ctx never
      // calls `beginStep`, so the step's own name, known once here, is the
      // only title its chunk (if `ctx.page()` is ever called) will use.
      stepTitle: name,
    });
    // `nuka do` is one execution, so `"scenario"` and `"process"` scope both
    // collapse to this one call's own lifetime: two separate, freshly
    // created caches (never shared across `nuka
    // do` invocations), each torn down once, below, after this step's own
    // `run()` returns.
    const fixtureScenarioCache = createFixtureCache();
    const fixtureProcessCache = createFixtureCache();
    // `"failed"` until this step's own outcome is known. A signal during
    // the step reads that, because the invocation did not finish.
    let fixtureOutcome: FixtureOutcome = "failed";
    let disposeResult: DisposeResult = { evidence: { screenshots: [] } };
    // Both caches tear down before dispose: a fixture built off `page`,
    // `context`, or `request` needs those still open. Scenario scope first,
    // matching `nuka run`. One function so the signal path and the normal
    // path below share a single run (`runOnce`).
    const tearDownFixtures = runOnce(async () => {
      const fixtureTeardownErrors = [
        ...(await teardownFixtureCache(fixtureScenarioCache, fixtureOutcome)),
        ...(await teardownFixtureCache(fixtureProcessCache, fixtureOutcome)),
      ];
      for (const teardownError of fixtureTeardownErrors) {
        // The message is the fixture's own text, so a value `ctx.env` handed
        // it is in there, and this line is not a step record.
        warnings("fixture-teardown-failed").write(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets) + "\n");
      }
      try {
        // No status argument: create-context.ts's own `dispose` doc comment
        // says why evidence no longer varies by outcome.
        disposeResult = await contextHandle.dispose();
      } catch {
        // Last resort: browser-evidence.ts and create-context.ts's own dispose
        // already swallow their teardown failures, but this catch is the final
        // backstop so a failure neither of them anticipated still can't take
        // the step record down with it (docs/spec.md "Records": a step record is
        // written for every execution that started). No evidence file is known
        // to exist in that case, so none is listed.
        disposeResult = { evidence: { screenshots: [] } };
      }
    });
    processSignal.setScenarioCleanup(tearDownFixtures);
    if (stopWorld !== undefined) processSignal.setProcessCleanup(stopWorld);
    const startedAt = new Date();

    // `--use`'s actual effect — applied here, not in
    // setup, so `recordUsed` rides `contextHandle`'s own collector (it didn't
    // exist yet in setup); mirrors run-scenario.ts's own `injectFrom`, called
    // after that file's equivalent step-start timestamp for the same reason.
    // `--args` still wins for a key it already set — `parsedArgs` is only
    // ever a plain object here for any key a
    // resolved `--use` could touch, because the `from` structural check
    // above already required `entry.step.args` to be an object schema for
    // every one of that step's own `from` keys.
    // --args is JSON, which has no bigint or Date, so a value this step's
    // args declare as one arrives as its stored string.
    parsedArgs = reviveStoredForm(entry.step.args, parsedArgs, "input");
    // Where each args key came from, for the step record's `args_origin`:
    // `--args` first, then each `--use` that filled a key `--args` left.
    const origins = new Map<string, ArgOrigin>();
    if (typeof parsedArgs === "object" && parsedArgs !== null && !Array.isArray(parsedArgs)) {
      const argsObject = parsedArgs as Record<string, unknown>;
      for (const key of Object.keys(argsObject)) origins.set(key, "command_line");
      for (const resolved of resolvedUses) {
        let filledAnyKey = false;
        for (const [key, value] of Object.entries(resolved.filled)) {
          if (!(key in argsObject)) {
            argsObject[key] = value;
            filledAnyKey = true;
            origins.set(key, {
              from: { step_record_id: resolved.used.step_record_id, step: resolved.used.step, key: resolved.sources[key] ?? key },
            });
          }
        }
        // Only a step record actually drawn from lands in `used` (docs/spec.md
        // "Single steps (the agent path)": the step record ids actually
        // drawn from land in this execution's own `used`) — one whose every
        // matching key was already overridden by `--args` contributed
        // nothing to this run, so it is not cited.
        if (filledAnyKey) {
          contextHandle.recordUsed(resolved.used.step_record_id, resolved.used.step, resolved.used.result);
        }
      }
    }

    const outcome = await executeTypedStep({
      name,
      step: entry.step,
      args: parsedArgs,
      handle: contextHandle,
      fixtureGraph,
      scenarioCache: fixtureScenarioCache,
      processCache: fixtureProcessCache,
      config,
      // No feature line produced a `--use` value, so its record id names
      // the producer instead.
      argSide: (key) => claimArgSide(key, origins.get(key), () => null),
      // No line states a value under nuka do: a key --args gave reads as
      // the JSON text it was given.
      sentenceText: (key) =>
        origins.get(key) === "command_line" && typeof parsedArgs === "object" && parsedArgs !== null && Object.hasOwn(parsedArgs, key)
          ? (JSON.stringify((parsedArgs as Record<string, unknown>)[key]) ?? null)
          : null,
    });
    const { status, fixtureUsage } = outcome;
    const recordedArgs = outcome.args;
    const argsOrigin = argOrigins(recordedArgs, (key) => origins.get(key));
    const result = outcome.status === "passed" ? outcome.result : undefined;
    const errorMessage = outcome.status === "failed" ? outcome.error.message : "";
    const errorKind: ErrorKind | undefined = outcome.status === "failed" ? outcome.error.kind : undefined;

    // A read-only environment already refused a *declared* mutator above, in
    // setup, before anything ran; a step that declared `mutates: false` yet
    // wrote over the wire anyway is no longer demoted for it here —
    // the declaration is trusted, and
    // `observed` below still records what actually happened, for a report
    // to catch a wrong declaration after the fact.
    const observed = await contextHandle.observedSnapshot();
    if (observed.program_log !== undefined && observed.program_log !== null) {
      const slice = observed.program_log;
      tracedSteps = [{ traceId: slice.trace_id, lines: slice.lines, stamped: slice.stamped, dir: evidenceDir }];
    }
    // `ctx.section` works the same under `nuka do` as under `nuka run` —
    // there is no scenario/pickle
    // concept here to special-case, so this is read the same way
    // `observed` is, right above.
    const sections = contextHandle.sectionsSnapshot();
    // Every `ctx.call(part, args)` invocation made directly by this
    // execution, read the same "after execution, whatever its outcome" way
    // `sections` is right above.
    const calls = contextHandle.callsSnapshot();
    // Every `ctx.poll` call that finished during this execution, read the
    // same "after execution, whatever its outcome" way `sections` is right
    // above — a poll that timed out or whose `fn` threw still finished, in
    // the sense that matters here, and its own record is what a step record for
    // a failed step needs most.
    const polls = contextHandle.pollsSnapshot();
    // Recorded even on a `MissingEnvError` failure (that throw happens
    // inside `entry.step.run`, above, well before this read) — same
    // "read the tally after execution, whatever its outcome" shape as
    // `observed`/`sections`.
    const requiredEnv = contextHandle.envReadsSnapshot();
    // Every step record `--use` actually drew a value from, in the order given
    // — the same collector `ctx.resultOf`
    // itself would write into, read the same "after execution" way
    // `observed`/`sections`/`requiredEnv` are, right above. Under `do`,
    // `ctx.resultOf` never returns a value (`resultOf: () => undefined`
    // above), so `--use` is the only thing that can ever populate this here.
    const used = contextHandle.usedSnapshot();
    // Console errors/uncaught page errors/failed requests the browser
    // context saw during this execution, read the same "after execution,
    // whatever its outcome" way `observed`/`sections`/`polls`/`requiredEnv`
    // are — `undefined` when `ctx.page()` was
    // never called, or was and the page stayed clean.
    const pageEvents = contextHandle.pageEventsSnapshot();
    // How many page-issued requests this execution made were left out of
    // http.jsonl, by resourceType, read the same "after execution, whatever
    // its outcome" way `pageEvents` just above is — `undefined` when
    // nothing was ever left out.
    const httpOmitted = contextHandle.httpOmittedSnapshot();
    const httpLogFailed = contextHandle.httpLogFailedSnapshot();
    // Application-specific evidence `evidence.attach`/`.path` produced this
    // execution, read the same "after execution, whatever
    // its outcome" way as every other snapshot above — a `path()`-allocated
    // file is confirmed to exist right here, on disk, so this needs neither
    // a browser nor `dispose()` to have already run.
    const evidenceSnapshot = await contextHandle.evidenceSnapshot();

    const finishedAt = new Date();

    // Same function the signal handler runs. `runOnce` makes a second call,
    // from whichever path loses the race, share that run. A teardown
    // failure never changes `status`.
    fixtureOutcome = status;
    await tearDownFixtures();
    await stopWorld?.();
    restoreEnv();
    const { evidence } = disposeResult;
    // `dispose()` above is what closes this execution's own (only) trace
    // chunk, if `ctx.page()` was ever called (create-context.ts's own
    // `closeCurrentChunk`) — trace.zip, when it exists at all, is fully
    // written by the time this runs, so `actions`/`truncated` can be read
    // out of it here.
    const traceEvidence = await collectTraceEvidence(
      evidenceDir,
      createTraceVersionWarner(warnings("trace-version-unknown")),
      "trace.zip",
      contextHandle.namedContexts(),
    );
    // Combines `traceEvidence`'s own `{ actions }` truncation with
    // `evidenceSnapshot`'s into the step record's single
    // top-level `truncated` field — see `mergeTruncated`'s own doc comment
    // (src/context/evidence.ts) for why this is one shared function rather
    // than two independent spreads.
    const truncated = mergeTruncated(traceEvidence.truncated, evidenceSnapshot.truncatedCount);
    // A claim step's claims, each with the channel its raw actual value was
    // measured on: this execution's own channels, read after dispose()
    // closed them, or the record a `--use` value came from.
    const claimFields =
      outcome.claims === undefined
        ? {}
        : {
            claims: withMeasured(outcome.claims.judged, {
              ownRecordId: recordId,
              ownChannels: recordedChannels({ observed, dir: evidenceDir, ...(evidence.http === undefined ? {} : { http: evidence.http }) }),
              fromRecordOf: (key) => {
                const origin = argsOrigin?.[key];
                return typeof origin === "object" ? origin.from.step_record_id : null;
              },
              channelsOf: (id) => {
                const record = readStepRecordById(rootDir, config.stateDir, id);
                return record === null ? [] : channelsOfStepRecord(rootDir, record);
              },
              secrets,
            }),
            observation: outcome.claims.observation,
            attempts: outcome.claims.attempts,
            ...(outcome.claims.readings === undefined ? {} : { readings: [...outcome.claims.readings] }),
            ...(outcome.claims.readingsLeftOut === undefined ? {} : { readings_left_out: { ...outcome.claims.readingsLeftOut } }),
          };

    const stepRecord: StepRecord =
      status === "passed"
        ? {
            schema_version: SCHEMA_VERSIONS.step_record,
            nukadoko: readOwnVersion(),
            step_record_id: recordId,
            step: name,
            kind: "do",
            args: recordedArgs,
            ...(argsOrigin !== undefined ? { args_origin: argsOrigin } : {}),
            result,
            status: "passed",
            environment: resolvedEnv.name,
            world_name: world?.view.name ?? null,
            target_version: targetVersion,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence: {
              dir: relativeDir,
              ...evidence,
              ...evidenceMetaFields(evidenceSnapshot),
            },
            observed,
            mutates: entry.step.mutates,
            // `omitUsedResults`: an
            // "passed" step record keeps `used`'s original `{ step_record_id, step }`
            // shape — see the failed branch just below for the case that keeps
            // the upstream's own result.
            ...(used.length > 0 ? { used: omitUsedResults(used) } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(calls.length > 0 ? { calls } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(httpLogFailed ? { http_log_failed: httpLogFailed } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
            ...claimFields,
          }
        : {
            schema_version: SCHEMA_VERSIONS.step_record,
            nukadoko: readOwnVersion(),
            step_record_id: recordId,
            step: name,
            kind: "do",
            args: recordedArgs,
            ...(argsOrigin !== undefined ? { args_origin: argsOrigin } : {}),
            // `errorKind` is always set by this point: `status` only ever
            // becomes `"failed"` alongside it, at each branch above. The
            // `?? "step_error"` fallback is a
            // belt-and-braces default, falling back to `step_error`
            // whenever the classification is
            // ambiguous — it should never actually be reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment: resolvedEnv.name,
            world_name: world?.view.name ?? null,
            target_version: targetVersion,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            mutates: entry.step.mutates,
            evidence: {
              dir: relativeDir,
              ...evidence,
              ...evidenceMetaFields(evidenceSnapshot),
            },
            observed,
            // Unstripped here, unlike the "passed" branch above: a failed
            // step's step record is
            // exactly where a reader most needs "what upstream value did
            // this `--use` draw on", without opening a second record.json.
            ...(used.length > 0 ? { used } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(calls.length > 0 ? { calls } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(httpLogFailed ? { http_log_failed: httpLogFailed } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
            ...claimFields,
          };

    // Redacted once, as one object — args/result/error.message and every
    // other field alike — then that single redacted object is what both
    // exits show: record.json and the
    // stdout copy must never be able to disagree about what got redacted.
    // `redact` is structurally shape-preserving (only string leaves ever
    // change), so this cast just tells the compiler what's already true.
    const redactedStepRecord = redact(stepRecord, secrets) as StepRecord;

    await writeStepRecord(evidenceDir, redactedStepRecord);

    stdout.write(`${JSON.stringify(redactedStepRecord, null, 2)}\n`);
    return status === "passed" ? 0 : 1;
  } finally {
    // A request the step left open after its record was written still
    // gets its line in http.jsonl (observed.ts).
    finalizeOpenRequests();
    await stopWorld?.();
    processSignal?.stop();
  }
}
