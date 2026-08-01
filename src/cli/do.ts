import { mkdir } from "node:fs/promises";
import path from "node:path";
import { formatValidationIssues } from "../binding/format-issues.js";
import { loadConfig } from "../config/load-config.js";
import { createStepContext, type DisposeResult } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { probeVersion } from "../environment/probe-version.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { generateReceiptId } from "../receipt/receipt-id.js";
import type { Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionFilePath, sessionLockPath } from "../session/paths.js";
import { readSessionFile, writeSessionFile } from "../session/store.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka do`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as vocabulary.ts).
// Two phases, matching docs/spec.md's "Running"/"Receipts" split exactly:
//
//   1. Setup — malformed --args JSON, an unknown step name, a config/
//      discovery error, an unknown `--env` name, a mutating step against a
//      `policy: "read-only"` environment, or an invalid `--session` name, a
//      lock held by another live process, or a malformed session file. None
//      of these write a receipt: the run never started, so there is nothing
//      to attest to (a receipt for an execution that never began would let a
//      nonexistent run be cited later as if it had happened).
//   2. Execution — from here a receipt is always written, whatever
//      happens: args schema failure, the step's own throw, and returns
//      schema failure are all `status: "failed"` with `error.message`; only
//      a step whose args and returns both validate and whose `run` doesn't
//      throw is `status: "ok"`.
//
// `--env` is resolved (environment/resolve-environment.ts) right after
// config loads and before anything session-related, because session paths
// are now per-environment (this task's spec, decision 7) — the resolved
// environment's name, not the raw `--env` string, is what every later
// sessions/<env>/ path uses. The version probe runs once, at the very top of
// the execution phase (decision 5): metadata about the target, never
// reachable from a step's own `run`, and its failure/timeout never fails the
// run — only `target_version` is omitted, with one stderr warning line.
//
// The evidence-collecting side of ctx (browser/http/trace) is created and
// disposed here, never handed to the step itself — see
// context/create-context.ts's header for why that split exists. Sessions
// follow the same rule: this module is the only place a session's file is
// actually read or written; `--session`'s lock is acquired right after it
// passes setup's name/config checks and is always released in `finally`,
// covering every return path below it (this task's spec, decision 4).
//
// This is also the one place a run's SecretSet is built (m1-secrets task
// spec, decision 2) and the one place a receipt gets redacted (decision 3):
// env is loaded and classified at the top of the execution phase against the
// *effective* envFiles (top-level + the resolved environment's own, m1-
// environments task spec, decision 8), and the finished receipt is redacted
// once, as a whole object, before either receipt.json or the stdout copy is
// written from it — never twice, independently, which could let the two
// drift apart.

export interface RunDoOptions {
  rootDir: string;
  name: string;
  argsJson: string;
  tag: string | null;
  /** Carries login state across `do` calls as Playwright storageState;
   * `null` means a clean start — no session file is read or written
   * (docs/spec.md "Sessions..."). */
  session: string | null;
  /** `--env`'s value, or `null` when it was omitted. `null` is not the same
   * as the string `"default"`: it is what tells resolveEnvironment() not to
   * require a matching `environments` entry (this task's spec, decision 2).
   */
  env: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runDo(options: RunDoOptions): Promise<number> {
  const { rootDir, name, argsJson, tag, session, env, stdout, stderr } = options;

  // --- Setup phase: any failure here writes nothing. ---
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch (error) {
    stderr.write(
      `Invalid JSON for --args: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // Environment resolution comes before anything session-related: session
  // paths below are per-environment, so the resolved environment's name has
  // to exist first. `env !== null` is what distinguishes "explicit --env
  // that must exist in config.environments" from "implicit default, no such
  // requirement" (this task's spec, decision 2) — see
  // resolve-environment.ts's header for the reasoning.
  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Name validation and lock acquisition happen together, still in setup:
  // a name that fails validation never reaches the filesystem at all, and a
  // lock conflict is reported before anything else about this run is
  // decided (this task's spec, decisions 4-5). `lockPath` stays `null`
  // exactly when `session` is `null`, so the `finally` below knows whether
  // there is anything to release.
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
    // A malformed session file is also a setup failure: unlike a missing
    // one (a session's first-ever use), it's data nukadoko itself owns, so
    // silently treating it as "no session" would risk restoring nothing
    // without saying so.
    let loadedStorageState: Awaited<ReturnType<typeof readSessionFile>> = null;
    if (session !== null) {
      try {
        loadedStorageState = await readSessionFile(
          sessionFilePath(rootDir, config.stateDir, resolvedEnv.name, session),
          session,
        );
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }

    let vocabulary;
    try {
      vocabulary = await discoverSteps(rootDir, config.featuresDir);
    } catch (error) {
      stderr.write(`${formatVocabularyError(error)}\n`);
      return 1;
    }

    const entry = vocabulary.get(name);
    if (!entry) {
      stderr.write(`Unknown step: ${name}\n`);
      return 1;
    }

    // Read-only refusal is a setup failure, not an execution failure (this
    // task's spec, decision 4): the step never runs, so nothing was
    // executed, so no receipt is written — writing one would let a run that
    // never happened be cited later as if it had. Read-only steps
    // (`mutates: false`) are unaffected regardless of policy.
    if (resolvedEnv.policy === "read-only" && entry.step.mutates) {
      stderr.write(
        `Step "${name}" mutates state but environment "${resolvedEnv.name}" has policy "read-only"\n`,
      );
      return 1;
    }

    // --- Execution phase: a receipt is always written from here on. ---
    const receiptId = generateReceiptId();
    const relativeDir = path.join(config.stateDir, "receipts", receiptId);
    const evidenceDir = path.join(rootDir, relativeDir);
    await mkdir(evidenceDir, { recursive: true });

    // The version probe runs first in the execution phase (this task's
    // spec, decision 5): it is metadata about the target the tool records
    // for itself, never something a step's own `run` can see or trigger. A
    // probe that throws or times out only costs `target_version`, never the
    // run — the step still executes normally below.
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

    // env is loaded once here (ctx.env's full, merged value) and classified
    // once here (which of those same envFiles are secret sources, per git —
    // m1-secrets task spec, decision 1); a classification failure (no git,
    // rootDir outside a repository) is itself handled inside
    // classifyEnvFiles by falling back to "everything is a secret source",
    // so it never surfaces here as a reason to fail this run. `envFiles`
    // here is the *effective* list — top-level plus the resolved
    // environment's own, later-wins (m1-environments task spec, decision 8)
    // — not just the top-level config's.
    const envFiles = resolvedEnv.envFiles;
    const envVars = loadEnvFiles(rootDir, envFiles);
    const classification = await classifyEnvFiles(rootDir, envFiles);
    const secrets = buildSecretSet(rootDir, classification.secretSource, config.secrets.public);

    const contextHandle = createStepContext({
      // Only `baseURL` is overridden from the resolved environment: every
      // other config field (featuresDir, stateDir, browser, ...) has no
      // per-environment counterpart (this task's spec, decision 3).
      config: { ...config, baseURL: resolvedEnv.baseURL },
      evidenceDir,
      env: envVars,
      secrets,
      storageState: loadedStorageState ?? undefined,
    });
    const startedAt = new Date();

    let status: "ok" | "failed";
    let result: unknown;
    let errorMessage = "";

    const argsResult = entry.step.args.safeParse(parsedArgs);
    if (!argsResult.success) {
      status = "failed";
      errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
    } else {
      try {
        const runResult = await entry.step.run(contextHandle.ctx, argsResult.data);
        const returnsResult = entry.step.returns.safeParse(runResult);
        if (!returnsResult.success) {
          status = "failed";
          errorMessage = `returns validation failed: ${formatValidationIssues(returnsResult.error.issues)}`;
        } else {
          status = "ok";
          result = returnsResult.data;
        }
      } catch (error) {
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    const finishedAt = new Date();
    let disposeResult: DisposeResult;
    try {
      disposeResult = await contextHandle.dispose(status);
    } catch {
      // Last resort: browser-evidence.ts and create-context.ts's own dispose
      // already swallow their teardown failures, but this catch is the final
      // backstop so a failure neither of them anticipated still can't take
      // the receipt down with it (docs/spec.md "Receipts": a receipt is
      // written for every execution that started). No evidence file is known
      // to exist in that case, so none is listed, and there is nothing to
      // persist for the session either.
      disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
    }
    const { evidence, storageState: storageStateToPersist } = disposeResult;

    // Save whenever a session was requested *and* dispose() actually
    // produced something to persist (this task's spec, decision 2): a run
    // that never opened a browser or request context leaves storageState
    // `undefined`, and the session file is left untouched — not created,
    // not overwritten, not deleted.
    if (session !== null && storageStateToPersist !== undefined) {
      try {
        await writeSessionFile(
          sessionFilePath(rootDir, config.stateDir, resolvedEnv.name, session),
          storageStateToPersist,
        );
      } catch {
        // Persisting the session must not cost the receipt, mirroring
        // dispose()'s own fault tolerance above; a write failure here just
        // leaves the session's previous file (if any) in place.
      }
    }

    const receipt: Receipt =
      status === "ok"
        ? {
            receipt_id: receiptId,
            step: name,
            kind: "do",
            args: parsedArgs,
            result,
            status: "ok",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session,
            tag,
            scenario: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence: { dir: relativeDir, ...evidence },
          }
        : {
            receipt_id: receiptId,
            step: name,
            kind: "do",
            args: parsedArgs,
            error: { message: errorMessage },
            status: "failed",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session,
            tag,
            scenario: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence: { dir: relativeDir, ...evidence },
          };

    // Redacted once, as one object — args/result/error.message and every
    // other field alike — then that single redacted object is what both
    // exits show (m1-secrets task spec, decision 3): receipt.json and the
    // stdout copy must never be able to disagree about what got redacted.
    // `redact` is structurally shape-preserving (only string leaves ever
    // change), so this cast just tells the compiler what's already true.
    const redactedReceipt = redact(receipt, secrets) as Receipt;

    await writeReceipt(evidenceDir, redactedReceipt);

    stdout.write(`${JSON.stringify(redactedReceipt, null, 2)}\n`);
    return status === "ok" ? 0 : 1;
  } finally {
    // Released regardless of which path above returned — setup failure,
    // execution failure, or success (this task's spec, decision 4: "実行
    // 終了時に必ず解放").
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
