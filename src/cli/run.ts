import path from "node:path";
import { checkBindings } from "../check/binding-check.js";
import { matchPickleStepText } from "../check/feature-check.js";
import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { createTraceVersionWarner } from "../context/trace-actions.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { createAllureEmitter, type AllureEmitter } from "../report/allure/emitter.js";
import { createMessagesEmitter, type MessagesEmitter } from "../report/messages/emitter.js";
import { buildStepBindings, type StepBinding } from "../run/match-step.js";
import { probeGitState } from "../run/probe-git.js";
import {
  createStepProgressLogger,
  writeOutputLocations,
  writeRunSummary,
  writeScenarioBoundary,
} from "../run/progress-log.js";
import { generateRunId } from "../run/run-id.js";
import {
  doneCallbackMessage,
  pendingOrSkippedMessage,
  runScenario,
  runWithTimeout,
  type StepFinishedInfo,
} from "../run/run-scenario.js";
import { parseFeatureTarget, selectPickles } from "../run/select-pickles.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionFilePath, sessionLockPath } from "../session/paths.js";
import { readSessionFile } from "../session/store.js";
import type { StorageState } from "../session/storage-state.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../step/validate-fixtures.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka run`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as cli/do.ts). Two
// phases, matching docs/spec.md's "Running"/"Receipts" split exactly —
// generalized from cli/do.ts's own split to every pickle this invocation
// selects (one feature file's worth, or, since run-directory-target, every
// `.feature` file under a directory target folded into this same one
// invocation) instead of one step:
//
//   1. Setup — a malformed feature target (missing file, invalid `:line`,
//      a parse failure — src/run/select-pickles.ts), a config/discovery
//      error, an unknown `--env` name, or an invalid `--session` name / a
//      lock held by another live process. None of these write anything: the
//      run never started, so there is nothing to attest to (this task's
//      spec, decision 2).
//   2. Execution — from the first pickle onward, every pickle that begins
//      executing gets a scenario record no matter what happens inside it
//      (src/run/run-scenario.ts); a malformed session file discovered before
//      a *later* scenario's own start is treated the same way a missing
//      feature file is — a failure before that scenario's execution began,
//      so no record is written for it, while earlier scenarios' output
//      stands (this task's spec, decision 8: storageState is re-read from
//      the session file at each scenario's own start, precisely so an
//      earlier scenario's save in the same run is visible to a later one).
//
// The version probe, `ctx.env`, and the run's SecretSet are each computed
// exactly once, at the top of the execution phase (this task's spec,
// decision 9) — every scenario record and every step receipt in this run
// shares the same `target_version`, `env`, and redaction rules. The
// session's lock, when `--session` is given, is acquired once for the whole
// run and always released in `finally` (this task's spec, decision 8),
// covering every scenario rather than one lock per scenario.
//
// m4a-run-provenance task spec: `runId` (src/run/run-id.ts) and `git`
// (src/run/probe-git.ts) join that same "computed once, at the top of the
// execution phase" group — one id and one git snapshot shared by every
// scenario record this invocation writes, alongside `targetVersion` above.
//
// `resolvedEnv.policy` is threaded into every `runScenario` call now
// (m2pre-resultof task spec, decision 3): this file previously never passed
// it at all, so `nuka run` enforced no read-only policy whatsoever, unlike
// `nuka do` — run-scenario.ts is where the actual refusal/backstop logic
// lives, since it needs a per-step, per-position view this module doesn't
// have.
//
// m2d-allure-shim task spec, item 1: `registerAllureRuntime()` is called
// once, at the top of the execution phase below (never in setup — a setup
// failure writes nothing, so there is no pickle for it to matter to yet),
// and its restore callback runs in this phase's own `finally`, nested inside
// the lock's own `finally`. Every pickle in this `for` loop shares that one
// registered `TestRuntime`; src/run/run-scenario.ts is what repoints which
// collector is "active" per pickle and per step/hook boundary.
//
// m21b-compat-execution task spec, item 3: each pickle's own feature's
// `gherkinDocument` (`SelectedFeature.gherkinDocument`, src/run/
// select-pickles.ts) is threaded into every `runScenario` call below — the
// same document for every pickle that came from the same file, since a
// Before/After hook's own `HookParameter.gherkinDocument` is that file's
// document regardless of which pickle triggered the hook. Extended by
// run-directory-target: a directory target's own pickles span more than one
// file now, each carrying *its own* feature's document via the
// `{ feature, pickle }` pairs `flatPickles` below builds, never a single
// shared one the way a lone `selected.gherkinDocument` field would have
// implied.
//
// m2b-compat-execution task spec closes m2a-compat-registry's two temporary
// asymmetries: `buildStepBindings` now receives `compatParameterTypes` too
// (previously dropped here as "irrelevant to this slice"), and
// `discoverSteps`'s `instantiateCompatWorld`/`compatHooks` are threaded into
// every `runScenario` call. Every registered hook's own tag expression (if
// any) is validated once, here in the setup phase, before any pickle runs
// (this task's spec, item 5): an unsupported tag expression's syntax is
// either supported or not, independent of which pickle a given `nuka run`
// invocation happens to select, so discovering it only when a matching
// pickle came along would make the failure look scenario-dependent, which
// it isn't.
//
// m22-compat-run-scope task spec, item 2: BeforeAll/AfterAll run here, not
// in src/run/run-scenario.ts — they are a property of this whole `nuka run`
// invocation, not of any one pickle, the same reason `registerAllureRuntime`
// above is called once here rather than once per scenario. Placed
// immediately around the pickle `for` loop below (after every setup-phase
// failure path has already returned, so environment/session/discovery are
// all settled by the time either one runs) and skipped entirely when
// `flatPickles` (below) is empty (this task's spec: a run that selects no
// pickle must not run BeforeAll/AfterAll at all — a run that executes
// nothing has nothing for a BeforeAll/AfterAll to prepare or tear down, and
// running one anyway would be a surprise side effect, e.g. standing up a
// server for a `nuka run` that never touches it). `BeforeAll` failing skips
// the pickle loop entirely but `AfterAll` is still attempted (mirrors
// src/run/run-scenario.ts's own Before/After asymmetry, applied one level
// up); neither has a record artifact of its own (none exists at the run
// level — this task's spec says not to invent one) — both report through
// stderr + this function's own exit code, the same channel setup failures
// above already use. `runWithTimeout`/
// `doneCallbackMessage`/`pendingOrSkippedMessage` are reused, unmodified,
// from src/run/run-scenario.ts (see that file's own header) rather than
// duplicated here.
//
// m3b-allure-emitter spec-b2 task spec, item 2: the Allure emitter is built
// and `begin()`-ed once, right after `hasPickles` is known (same gate as
// BeforeAll/AfterAll above, same reason — a run that selects nothing has
// nothing for the emitter to have measured either, so it never creates
// `allure-results/`). Both the construction and `begin()` are wrapped in one
// try/catch here even though every one of its other methods already carries
// its own (src/report/allure/emitter.ts): `createAllureEmitter` creates
// `resultsDir` synchronously (src/report/allure/writer.ts's
// `createAtomicWriter`), a step that can throw before any of the emitter's
// own internal safety net exists. A failure here is a warning to stderr,
// never a run failure — measurement must not break execution — and leaves
// `allureEmitter` `null`, so every `beginScenario`/`emitStep`/`endScenario`
// call in the pickle loop below is skipped for the rest of this run.
//
// allure-step-as-test task spec, decision 2: a pickle's own `emitStep` calls
// happen live, once per step, threaded through `runScenario`'s own
// `onStepFinished` (never gated on `--quiet`, decision 3) — well before
// that pickle's own `stdout.write` below, which only happens once the whole
// scenario is done. `endScenario` (hooks + scenario-level evidence + the
// scope those steps' own tests already reference) still happens after the
// `stdout.write`, the same position `emitScenario` used to hold: stdout's
// one-line-per-scenario contract must never be disturbed by an emit
// failure, and none of these three methods ever throws. `record.status`/the
// run's exit code/stdout's content are all otherwise untouched by any of
// this.
//
// m3c-messages-emitter spec-b task spec, item 2: the messages emitter is
// built and `begin()`-ed right after the Allure emitter above — same
// `hasPickles` gate, same one try/catch around construction+`begin()`, same
// stderr-warning-only failure handling, for the same reasons (see the
// paragraph above and src/report/messages/emitter.ts's own header). Its
// `emitScenario` call — unaffected by this task, out of its own scope —
// sits immediately after the Allure emitter's own `endScenario`, both still
// after the pickle loop's `stdout.write` of that scenario's record.
// `end(allPassed)` is placed after the AfterAll loop below, immediately
// before this function's own `return` (item 2, decision 4): it is the one
// place `allPassed` has already absorbed every BeforeAll/AfterAll failure,
// so `testRunFinished.success` in the emitted stream is guaranteed to equal
// this run's own exit code — this emitter's only channel for a run-scope
// hook's failure, since neither hook has a record of its own to carry it.
//
// Output-file semantics (item 3): one `nuka run` invocation is one stream,
// written to one file; `begin()` truncates it (appending would produce a
// second `testRunStarted` in what must read back as a single well-formed
// message stream). One invocation can select more than one feature file now
// (run-directory-target task spec: a directory target folds every `.feature`
// file it walked into this same one stream, `begin()` called once with all
// of them — see that call site below), but it is still exactly one
// invocation, one stream: running `nuka run` a second time, whether against
// one file or a directory, overwrites the first run's stream rather than
// appending to it — a deliberate consequence of "one file, truncated on
// begin", not a bug.
//
// m6b-from-check task spec, item 2's own leftover: `from`'s structural
// validation (src/step/validate-from.ts's `validateStepFrom`, m6a-from-core
// task spec) is now wired in here too, not just `nuka do` — a setup-phase
// fatal (stderr + exit 1, no scenario ever written), run once for this whole
// invocation right after `bindings` builds, never once per pickle (this
// check is scenario-independent, see that file's own header). Scoped to the
// step names this run's own selected pickles actually resolve to
// (`usedStepNames` below, via the same `checkBindings`/`matchPickleStepText`
// seam src/check/from-order.ts's own guard reuses) rather than the whole
// vocabulary: a broken `from` on a step this invocation never binds to is
// not this invocation's problem to refuse over, the same "only the step
// you're about to run" scope cli/do.ts's own wiring already has — `nuka
// check` is where a project-wide finding like that belongs instead. The
// scenario-order guard itself (docs/spec.md "Chaining steps") is a second,
// separate check, run once *per pickle* inside src/run/run-scenario.ts —
// see that file's own header for why it has to live there instead of here.
//
// partial-run-visibility task spec: a `:line` target gets one stderr line
// right after `selectPickles` resolves it, naming that the run is partial
// and that `nuka accept` refuses it — said here rather than left for accept
// to reveal several commands later (docs/spec.md "Scenarios (the scripted
// path)"). stdout is untouched: its one-record-per-line contract (below)
// is read by machines, and this notice is not part of it.
//
// fb5-run-output task spec: the execution phase used to run in complete
// silence between setup and its own final `stdout.write`/exit code — no way
// to tell a long scenario apart from a stuck one, and no way to learn where
// a run's own output landed short of already knowing `config`. Every line
// this task adds (src/run/progress-log.ts) goes to stderr, never stdout —
// stdout's one-JSON-record-per-scenario contract (`stdout.write` below,
// item 2 in this file's own earlier history) stays exactly as it was.
// `onStepProgress` is built once here, the same "one instance per
// invocation, threaded unchanged into every `runScenario` call" shape
// `onUnknownTraceVersion` above already has, and is `undefined` under
// `--quiet` (decision 4: `--quiet` suppresses only the step and scenario
// boundary lines — `writeOutputLocations`/`writeRunSummary` near this
// function's own `return` are unconditional, since each is written exactly
// once and naming where output landed is never worth suppressing for a flag
// whose point is a quieter terminal, not a silent one). No TTY check
// anywhere in this: a CI log wants this exact progress just as much as an
// interactive terminal does, and stderr staying busy costs nothing stdout's
// own NDJSON readers can see.

export interface RunRunOptions {
  rootDir: string;
  /** `<feature[:line]>`, e.g. "features/checkout.feature:12". */
  featureArg: string;
  session: string | null;
  env: string | null;
  /** Suppresses the per-step and per-scenario progress lines (fb5-run-output
   * task spec, decision 4) — the output-location and summary lines at the
   * end of a run are written either way; see this file's own header. */
  quiet: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runRun(options: RunRunOptions): Promise<number> {
  const { rootDir, featureArg, session, env, quiet, stdout, stderr } = options;

  // This whole invocation's own start (fb5-run-output task spec) — read
  // again just before the summary line is written, near this function's own
  // `return`, so that line's own elapsed time covers the whole invocation
  // (config load and discovery included), not just the pickle loop.
  const invocationStartedAt = new Date();

  // --- Setup phase: any failure here writes nothing. ---
  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let lockPath: string | null = null;
  if (session !== null) {
    try {
      validateSessionName(session);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    lockPath = sessionLockPath(rootDir, config.stateDir, resolvedEnv.name, session);
    try {
      await acquireLock(lockPath, session);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  try {
    let vocabulary;
    let compatParameterTypes;
    let instantiateCompatWorld;
    let compatHooks;
    let compatRunHooks;
    let defaultTimeoutMs;
    try {
      ({
        vocabulary,
        compatParameterTypes,
        instantiateCompatWorld,
        compatHooks,
        compatRunHooks,
        defaultTimeoutMs,
      } = await discoverSteps(rootDir, config.featuresDir));
    } catch (error) {
      stderr.write(`${formatVocabularyError(error)}\n`);
      return 1;
    }

    // Every registered hook's own tag expression (this task's spec, item
    // 5) — a setup failure, same family as the parameterTypes collision
    // below, not attributable to any one pickle.
    try {
      for (const hook of compatHooks) {
        if (hook.tags !== undefined) {
          validateTagExpression(hook.tags);
        }
      }
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    let selected;
    try {
      selected = selectPickles(rootDir, featureArg);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    // Flattened once, here, into the `{ feature, pickle }` pairs every use
    // below actually needs (run-directory-target task spec): `selected.
    // features` stays grouped by file for the messages emitter's own
    // `begin()` call (its own site below), but every other use — counting,
    // the from/fixture checks, the pickle loop itself — wants one ordered
    // sequence across every file, each pickle still paired with *its own*
    // feature's `relativePath`/`gherkinDocument`, never a stray shared one.
    const flatPickles = selected.features.flatMap((feature) =>
      feature.pickles.map((pickle) => ({ feature, pickle })),
    );

    // See this file's own header (partial-run-visibility task spec) — no
    // notice at all when `:line` wasn't given, so a normal full run stays
    // silent every time. `:line` on a directory target is refused in setup
    // (src/run/select-pickles.ts's `DirectoryTargetLineError`), so reaching
    // here with a non-null `line` always means a single-file target.
    if (parseFeatureTarget(featureArg).line !== null) {
      stderr.write(
        `Partial run: ${featureArg} selects ${flatPickles.length} of ${selected.totalPickles} scenarios. ` +
          "A partial run cannot be accepted; `nuka accept` needs a run of the whole feature.\n",
      );
    }

    // --- Execution phase: from here, every pickle that begins gets a
    // scenario record written, whatever happens inside it. ---
    // Building bindings is the one exception: it happens once, before any
    // pickle's own record exists, so a config.parameterTypes/compat
    // defineParameterType name collision here (src/binding/registry.ts's
    // ParameterTypeCollisionError) is treated as a setup failure, not a
    // scenario failure (m2pre-parameter-types task spec, decision 3) — no
    // scenario record is ever written for it.
    let bindings: readonly StepBinding[];
    try {
      bindings = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    // The same check-time patterns `nuka check` builds (this file's own
    // header, m6b-from-check task spec) — a broken pattern here simply
    // doesn't appear in `patterns` (`checkBindings`'s own issues/warnings are
    // check's report to make, not this setup phase's to fail over; a pattern
    // that fails to build can't match anything either way, so it surfaces as
    // "undefined" exactly like it already does). Built once, shared by
    // `usedStepNames` below and by every pickle's own from-order guard
    // (src/run/run-scenario.ts's `RunScenarioOptions.patterns`).
    const { patterns } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);

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
      stderr.write(`${formatFromIssues(fromIssues)}\n`);
      return 1;
    }

    // The fixture-bag counterpart to the `from` structural check just above
    // (p4a-fixture-bag task spec, scope item 3) — same "scenario-independent,
    // scoped to the steps this invocation actually binds to" shape, checked
    // once per step name rather than once per pickle. `knownNames` widens
    // the closed builtin-only set to builtins ∪ `config.fixtures` (P5 task
    // spec, scope item 5) — the same set `nuka check` validates a step's
    // own usage against (src/check/analyze.ts).
    const fixtureGraph = buildFixtureGraph(config);
    const knownNames = knownFixtureNames(config);
    const fixtureIssues = [...vocabulary.values()].flatMap((entry) =>
      entry.kind === "typed" && usedStepNames.has(entry.name)
        ? validateStepFixtures(entry.name, entry.step, knownNames)
        : [],
    );
    if (fixtureIssues.length > 0) {
      stderr.write(`${formatFixtureIssues(fixtureIssues)}\n`);
      return 1;
    }

    // The `config.fixtures` *definitions* themselves (P5 task spec, scope
    // item 8) — cycles, `"process"`-scope-depends-on-`"scenario"`-scope, and an
    // unowned `page` override — the same three findings `nuka check`
    // reports, refused here before execution the same way `fixtureIssues`
    // above already is. Unconditional, unlike `fixtureIssues`: these are
    // properties of `config.fixtures` itself, not of any one step's own
    // usage, so they are not scoped to `usedStepNames` — the same
    // "validate the whole config regardless of what this run happens to
    // touch" convention src/check/config-check.ts already follows.
    const fixtureDefinitionIssues = validateFixtureDefinitions(config);
    if (fixtureDefinitionIssues.length > 0) {
      stderr.write(`${formatFixtureDefinitionIssues(fixtureDefinitionIssues)}\n`);
      return 1;
    }

    const probeResult = await probeVersion(resolvedEnv.version);
    let targetVersion: string | undefined;
    if (probeResult !== undefined) {
      if (probeResult.ok) {
        targetVersion = probeResult.version;
      } else {
        stderr.write(
          `Warning: version probe for environment "${resolvedEnv.name}" failed: ${probeResult.reason}\n`,
        );
      }
    }

    const runId = generateRunId();
    const git = await probeGitState(rootDir);
    // One instance for this whole `nuka run` invocation (p3a-trace-per-step
    // task spec, scope B item 2) — passed unchanged into every `runScenario`
    // call below, so a run whose several steps (across one scenario or
    // several) each hit an unreadable trace version still only ever writes
    // the stderr warning once, not once per occurrence.
    const onUnknownTraceVersion = createTraceVersionWarner(stderr);

    // Same "one instance, threaded unchanged into every `runScenario` call"
    // shape as `onUnknownTraceVersion` just above (fb5-run-output task spec)
    // — `undefined` under `--quiet` so `runScenario` never has to know that
    // flag exists at all; it only ever sees "is there a callback to call".
    const onStepEnd = quiet ? undefined : createStepProgressLogger(stderr);

    const envFiles = resolvedEnv.envFiles;
    const envVars = loadEnvFiles(rootDir, envFiles);
    const classification = await classifyEnvFiles(rootDir, envFiles);
    const secrets = buildSecretSet(rootDir, {
      secretSourceFiles: classification.secretSource,
      trackedFiles: classification.tracked,
      publicKeys: config.secrets.public,
      redactKeys: config.secrets.redact,
    });

    // Only `baseURL` is overridden from the resolved environment, same as
    // cli/do.ts: every other config field has no per-environment counterpart.
    const runConfig = { ...config, baseURL: resolvedEnv.baseURL };
    const thisSessionFilePath =
      session !== null ? sessionFilePath(rootDir, config.stateDir, resolvedEnv.name, session) : null;

    // m22-compat-run-scope task spec, item 2: runs one BeforeAll/AfterAll
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
      try {
        // Same arity-based done-callback signal as src/run/run-scenario.ts's
        // own hooks, adjusted for a run-scope hook's own zero-argument call
        // convention (src/compat/run-hooks.ts's `RunHookFn` header): *any*
        // declared parameter, not just a second one, is the signal here.
        if (hook.fn.length >= 1) {
          throw new Error(doneCallbackMessage("Hook", label));
        }
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(undefined)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          label,
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          throw new Error(pendingOrSkippedMessage("Hook", label, returnValue));
        }
        return true;
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return false;
      }
    };

    // --- Execution phase proper: registered once for every pickle below
    // (m2d-allure-shim task spec, item 1) — see this file's own header. ---
    const restoreAllureRuntime = registerAllureRuntime();
    try {
      let allPassed = true;
      // Tallied alongside `allPassed` above, read by the summary/output-
      // location lines near this function's own `return` (fb5-run-output
      // task spec, decisions 2-3) — `scenariosWritten`/`scenariosPassed`
      // count actual `stdout.write`s below, never `flatPickles.length`:
      // a BeforeAll failure or a mid-loop storageState read failure can
      // leave this run with fewer scenario records than pickles selected,
      // and the summary line must say what actually happened, not what was
      // asked for. `receiptsWritten` sums every step across every one of
      // those records whose own `receipt` is non-null.
      let scenariosWritten = 0;
      let scenariosPassed = 0;
      let receiptsWritten = 0;

      // Skipped entirely for a run that selects zero pickles (this task's
      // spec: no pickle selected means BeforeAll/AfterAll never run) —
      // `hasPickles` gates every step below, including AfterAll.
      const hasPickles = flatPickles.length > 0;

      // This whole invocation's own `"process"`-scope fixture cache (P5 task
      // spec, scope item 3) — one instance, shared by every `runScenario`
      // call below, so a `"process"`-scope fixture named by more than one
      // scenario is built exactly once (this task's own completion
      // condition 5) and torn down exactly once, after the pickle loop
      // (below, near AfterAll). Cheap to create even for a zero-pickle run
      // — an empty cache's own teardown is a no-op.
      const fixtureProcessCache = createFixtureCache();

      // Root-relative (src/config/schema.ts's own doc comment for each of
      // these two keys) — computed once, ahead of `resultsDir`/`output`
      // below, so this exact resolved value (config default already
      // applied) is available for the output-location line near this
      // function's own `return` too (fb5-run-output task spec, decision 2:
      // "実際の書き込み先", the resolved value, not the config key itself),
      // whether or not the emitter that writes there actually succeeds.
      const allureResultsDirRel = config.allure?.resultsDir ?? path.join(config.stateDir, "allure-results");
      const messagesOutputRel = config.messages?.output ?? path.join(config.stateDir, "messages.ndjson");

      // See this file's own header (m3b-allure-emitter spec-b2 task spec,
      // item 2) for why this is gated on `hasPickles`, why construction and
      // `begin()` are wrapped together, and why a failure here never fails
      // the run.
      let allureEmitter: AllureEmitter | null = null;
      if (hasPickles) {
        try {
          const resultsDir = path.join(rootDir, allureResultsDirRel);
          allureEmitter = createAllureEmitter({
            resultsDir,
            rootDir,
            environment: resolvedEnv.name,
            targetVersion,
            secrets,
            stderr,
          });
          allureEmitter.begin();
        } catch (error) {
          allureEmitter = null;
          stderr.write(
            `Warning: allure emitter setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }

      // See this file's own header (m3c-messages-emitter spec-b task spec,
      // item 2) for the gate, the try/catch shape, and the output-file
      // truncate semantics.
      let messagesEmitter: MessagesEmitter | null = null;
      if (hasPickles) {
        try {
          const output = path.join(rootDir, messagesOutputRel);
          messagesEmitter = createMessagesEmitter({ output, rootDir, stderr });
          // One `features` entry per file `selected` carries (run-directory-
          // target task spec) — `selected.features` is already in this
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
          stderr.write(
            `Warning: messages emitter setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
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
            // Stop at the first BeforeAll failure (this task's spec: stop
            // the rest of the run at the first failure — same convention
            // as scenario-level Before).
            break;
          }
        }
      }

      if (hasPickles && !beforeAllFailed) {
        for (const [pickleIndex, { feature, pickle }] of flatPickles.entries()) {
          let storageState: StorageState | null = null;
          if (session !== null) {
            try {
              // Read fresh for every scenario (this task's spec, decision 8):
              // an earlier scenario in this same run may have just saved a
              // new storageState, and the file is the single source of truth
              // for that hand-off. A failure here means this scenario's own
              // execution has not begun yet, so it gets no record — the same
              // "never began" guarantee a missing feature file gets in setup.
              storageState = await readSessionFile(thisSessionFilePath!, session);
            } catch (error) {
              stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
              // Deliberately not `return 1` (which is what this path did
              // before run-scope hooks existed): BeforeAll has already run by
              // now, and AfterAll's whole contract is that teardown is
              // attempted whenever setup was — returning straight out would
              // leak whatever BeforeAll started. Break instead, let the
              // AfterAll block below run, and let `allPassed` carry the same
              // non-zero exit code out.
              allPassed = false;
              break;
            }
          }

          // This pickle's own boundary line (fb5-run-output task spec,
          // decision 1) — right before its execution actually begins, not
          // before the storageState read above: a scenario whose
          // storageState read failed never begins at all (see that catch's
          // own comment), so it gets no boundary line either, the same
          // "never began" shape a missing feature file already gets.
          if (!quiet) {
            writeScenarioBoundary(stderr, {
              index: pickleIndex + 1,
              total: flatPickles.length,
              relativeFeaturePath: feature.relativePath,
              line: pickle.location?.line ?? 0,
              name: pickle.name,
            });
          }

          // Opens this scenario's own Allure scope right before its first
          // step can possibly run (allure-step-as-test task spec, decision
          // 2) — `emitStep` below needs it to already exist the moment the
          // first step finishes. `undefined` — a no-op — when this run has
          // no Allure emitter at all (setup failure or zero pickles, this
          // file's own header).
          allureEmitter?.beginScenario();

          // One instance per pickle (allure-step-as-test task spec,
          // decision 2), unlike `onStepEnd` above: it closes over this
          // pickle's own `gherkinDocument`/`relativeFeaturePath`, which
          // `run-scenario.ts`'s own `StepFinishedInfo` does not carry (that
          // struct is per-*step*, not per-*scenario*). Built regardless of
          // `quiet` — the report's own granularity does not follow the
          // terminal's (this task's spec, decision 3) — and is itself a
          // no-op when `allureEmitter` is `null`.
          const onStepFinished: ((info: StepFinishedInfo) => void) | undefined = allureEmitter
            ? (info) => {
                allureEmitter?.emitStep({
                  ...info,
                  gherkinDocument: feature.gherkinDocument,
                  pickle,
                  relativeFeaturePath: feature.relativePath,
                  environment: resolvedEnv.name,
                  session,
                  targetVersion,
                  runId,
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
            session,
            env: envVars,
            secrets,
            storageState,
            sessionFilePath: thisSessionFilePath,
            instantiateCompatWorld,
            compatHooks,
            defaultTimeoutMs,
            onUnknownTraceVersion,
            onStepEnd,
            onStepFinished,
            fixtureGraph,
            fixtureProcessCache,
          });

          // One JSON line per completed scenario record, streamed as it
          // finishes (this task's spec, decision 7); everything else about
          // this run goes to stderr, never stdout.
          stdout.write(`${JSON.stringify(record)}\n`);
          scenariosWritten += 1;
          if (record.status === "passed") {
            scenariosPassed += 1;
          }
          receiptsWritten += record.steps.filter((step) => step.receipt !== null).length;
          // A `"scenario"`-scope fixture's own teardown failure (P5 task
          // spec, scope item 6) — already recorded on `record.teardown_
          // errors` (src/run/run-scenario.ts); announced here too, on
          // stderr, so it is never silent even though it never changes
          // `record.status` or this run's own exit code.
          for (const teardownError of record.teardown_errors ?? []) {
            stderr.write(
              `Warning: fixture "${teardownError.fixture}" teardown failed: ${teardownError.message}\n`,
            );
          }
          // After the stdout line, always — see this file's own header.
          // `allureEmitter` is `null` when this run selected zero pickles or
          // its own setup failed above; `endScenario` itself never throws.
          // Every one of this scenario's own steps has already had its own
          // `emitStep` call by now (allure-step-as-test task spec, decision
          // 2) — this call only maps hooks/scenario-level evidence into
          // fixtures and writes the scope those steps' own tests already
          // reference.
          allureEmitter?.endScenario({
            record,
            gherkinDocument: feature.gherkinDocument,
            pickle,
            relativeFeaturePath: feature.relativePath,
          });
          messagesEmitter?.emitScenario({ record, pickle });
          if (record.status !== "passed") {
            allPassed = false;
          }
        }
      }

      // AfterAll is attempted whether or not BeforeAll failed, and whether
      // or not any pickle actually passed (this task's spec: AfterAll is
      // attempted regardless) — the only thing that suppresses it is
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

      // `"process"`-scope fixture teardown (P5 task spec, scope items 3, 6)
      // — once, after every scenario in this invocation has finished, after
      // AfterAll (a `"process"`-scope fixture is nukadoko's own machinery,
      // not a compat hook's teardown target, so it has no ordering promise
      // relative to AfterAll beyond "after every scenario"). Never changes
      // `allPassed` — a teardown failure must not turn an otherwise-green
      // run red for a reason unrelated to the acceptance criteria, the same
      // rule scenario-scope teardown follows — and, unlike a scenario-scope
      // failure, has no single `ScenarioRecord` of its own to land on (this
      // process-scope cache spans every scenario in the invocation, not
      // one), so it is announced on stderr only.
      const processFixtureTeardownErrors = await teardownFixtureCache(
        fixtureProcessCache,
        allPassed ? "passed" : "failed",
      );
      for (const teardownError of processFixtureTeardownErrors) {
        stderr.write(
          `Warning: fixture "${teardownError.fixture}" teardown failed: ${teardownError.message}\n`,
        );
      }

      // See this file's own header (m3c-messages-emitter spec-b task spec,
      // item 2) for why this must run here — after BeforeAll/AfterAll have
      // had their chance to flip `allPassed`, immediately before the
      // `return` below that turns it into this run's own exit code.
      messagesEmitter?.end(allPassed);

      // fb5-run-output task spec, decisions 2-3: where this run actually
      // wrote, then a one-line summary — both unconditional, `--quiet`
      // included (see this file's own header). `receipts`/`scenarios` are
      // gated on `scenariosWritten > 0`, not `hasPickles`: a BeforeAll
      // failure leaves `hasPickles` true with zero scenario records ever
      // written, and this table only ever names what this run actually
      // wrote. `allure`/`messages` are gated on `hasPickles` itself
      // (run.ts:530,557 above — the same condition that gates their own
      // construction): each writes its own environment/categories or
      // stream-header data as soon as it is constructed, before any one
      // scenario's own record exists to write.
      writeOutputLocations(stderr, [
        ...(scenariosWritten > 0
          ? [
              {
                label: "receipts",
                relativePath: path.join(config.stateDir, "receipts"),
                kind: "dir" as const,
                count: receiptsWritten,
              },
              {
                label: "scenarios",
                relativePath: path.join(config.stateDir, "scenarios"),
                kind: "dir" as const,
                count: scenariosWritten,
              },
            ]
          : []),
        ...(hasPickles
          ? [
              { label: "allure", relativePath: allureResultsDirRel, kind: "dir" as const },
              { label: "messages", relativePath: messagesOutputRel, kind: "file" as const },
            ]
          : []),
      ]);
      writeRunSummary(stderr, {
        total: scenariosWritten,
        passed: scenariosPassed,
        failed: scenariosWritten - scenariosPassed,
        durationMs: Date.now() - invocationStartedAt.getTime(),
      });

      return allPassed ? 0 : 1;
    } finally {
      restoreAllureRuntime();
    }
  } finally {
    // Released regardless of which path above returned (this task's spec,
    // decision 8: acquired once for the whole run, released in `finally`).
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
