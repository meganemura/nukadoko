import { registerAllureRuntime } from "../compat/allure-runtime.js";
import { validateTagExpression } from "../compat/tag-expression.js";
import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { buildStepBindings, type StepBinding } from "../run/match-step.js";
import {
  doneCallbackMessage,
  pendingOrSkippedMessage,
  runScenario,
  runWithTimeout,
} from "../run/run-scenario.js";
import { selectPickles } from "../run/select-pickles.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionFilePath, sessionLockPath } from "../session/paths.js";
import { readSessionFile } from "../session/store.js";
import type { StorageState } from "../session/storage-state.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka run`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as cli/do.ts). Two
// phases, matching docs/spec.md's "Running"/"Receipts" split exactly —
// generalized from cli/do.ts's own split to a whole feature file's worth of
// pickles instead of one step:
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
// m21b-compat-execution task spec, item 3: `selected.gherkinDocument` (src/
// run/select-pickles.ts) is threaded into every `runScenario` call below —
// the same document for every pickle in this feature file, since a
// Before/After hook's own `HookParameter.gherkinDocument` is this file's
// document regardless of which pickle triggered the hook.
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
// `selected.pickles` is empty (this task's spec: "pickle が 1 つも選択されて
// いない場合は実行しない" — a run that executes nothing has nothing for a
// BeforeAll/AfterAll to prepare or tear down, and running one anyway would
// be a surprise side effect, e.g. standing up a server for a `nuka run` that
// never touches it). `BeforeAll` failing skips the pickle loop entirely but
// `AfterAll` is still attempted (mirrors src/run/run-scenario.ts's own
// Before/After asymmetry, applied one level up); neither has a record
// artifact of its own (none exists at the run level — this task's spec:
// "発明しない") — both report through stderr + this function's own exit
// code, the same channel setup failures above already use. `runWithTimeout`/
// `doneCallbackMessage`/`pendingOrSkippedMessage` are reused, unmodified,
// from src/run/run-scenario.ts (see that file's own header) rather than
// duplicated here.

export interface RunRunOptions {
  rootDir: string;
  /** `<feature[:line]>`, e.g. "features/checkout.feature:12". */
  featureArg: string;
  session: string | null;
  env: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runRun(options: RunRunOptions): Promise<number> {
  const { rootDir, featureArg, session, env, stdout, stderr } = options;

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

    const envFiles = resolvedEnv.envFiles;
    const envVars = loadEnvFiles(rootDir, envFiles);
    const classification = await classifyEnvFiles(rootDir, envFiles);
    const secrets = buildSecretSet(rootDir, classification.secretSource, config.secrets.public);

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

      // Skipped entirely for a run that selects zero pickles (this task's
      // spec: "pickle が 1 つも選択されていない場合は実行しない") — `hasPickles`
      // gates every step below, including AfterAll.
      const hasPickles = selected.pickles.length > 0;
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
            // Stop at the first BeforeAll failure (this task's spec: "最初
            // の失敗で残りを中断" — same convention as scenario-level Before).
            break;
          }
        }
      }

      if (hasPickles && !beforeAllFailed) {
        for (const pickle of selected.pickles) {
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

          const record = await runScenario({
            rootDir,
            config: runConfig,
            pickle,
            relativeFeaturePath: selected.relativePath,
            gherkinDocument: selected.gherkinDocument,
            vocabulary,
            bindings,
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
          });

          // One JSON line per completed scenario record, streamed as it
          // finishes (this task's spec, decision 7); everything else about
          // this run goes to stderr, never stdout.
          stdout.write(`${JSON.stringify(record)}\n`);
          if (record.status !== "passed") {
            allPassed = false;
          }
        }
      }

      // AfterAll is attempted whether or not BeforeAll failed, and whether
      // or not any pickle actually passed (this task's spec: "AfterAll は
      // それでも試行する") — the only thing that suppresses it is
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

      return allPassed ? 0 : 1;
    } finally {
      restoreAllureRuntime();
    }
  } finally {
    // Released regardless of which path above returned (this task's spec,
    // decision 8: "run 全体で1回取得・finally で解放").
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
