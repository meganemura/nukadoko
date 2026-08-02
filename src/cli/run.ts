import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { buildStepBindings } from "../run/match-step.js";
import { runScenario } from "../run/run-scenario.js";
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
    try {
      vocabulary = await discoverSteps(rootDir, config.featuresDir);
    } catch (error) {
      stderr.write(`${formatVocabularyError(error)}\n`);
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
    const bindings = buildStepBindings(vocabulary);

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

    let allPassed = true;
    for (const pickle of selected.pickles) {
      let storageState: StorageState | null = null;
      if (session !== null) {
        try {
          // Read fresh for every scenario (this task's spec, decision 8):
          // an earlier scenario in this same run may have just saved a new
          // storageState, and the file is the single source of truth for
          // that hand-off. A failure here means this scenario's own
          // execution has not begun yet, so it gets no record — the same
          // "never began" guarantee a missing feature file gets in setup.
          storageState = await readSessionFile(thisSessionFilePath!, session);
        } catch (error) {
          stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
      }

      const record = await runScenario({
        rootDir,
        config: runConfig,
        pickle,
        relativeFeaturePath: selected.relativePath,
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
      });

      // One JSON line per completed scenario record, streamed as it
      // finishes (this task's spec, decision 7); everything else about this
      // run goes to stderr, never stdout.
      stdout.write(`${JSON.stringify(record)}\n`);
      if (record.status !== "passed") {
        allPassed = false;
      }
    }

    return allPassed ? 0 : 1;
  } finally {
    // Released regardless of which path above returned (this task's spec,
    // decision 8: "run 全体で1回取得・finally で解放").
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
