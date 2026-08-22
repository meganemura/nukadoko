import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { formatValidationIssues } from "../binding/format-issues.js";
import { loadConfig } from "../config/load-config.js";
import { createStepContext, type StepContextHandle } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
import { mergeTruncated } from "../context/evidence.js";
import { collectTraceEvidence } from "../context/trace-actions.js";
import { omitUsedResults } from "../context/used.js";
import { discoverSteps } from "../discover/discover-steps.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { probeVersion } from "../environment/probe-version.js";
import { buildFixtureGraph, type FixtureGraph } from "../fixture/graph.js";
import {
  createFixtureCache,
  resolveFixtures,
  teardownFixtureCache,
  type FixtureUsageEntry,
} from "../fixture/resolver.js";
import { generateStepRecordId } from "../record/record-id.js";
import { readStepRecordById } from "../record/read-step-record.js";
import type { ErrorKind, EvidenceMeta, StepRecord } from "../record/types.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { resolveUse, type ResolveUseSuccess } from "../cli/resolve-use.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { sessionFilePath, sessionLockPath, sessionsDir } from "../session/paths.js";
import { readSessionFile, writeSessionFile } from "../session/store.js";
import { LIVE_SOCK_DIR_PREFIX, LIVE_SOCK_FILE_NAME } from "./live-sock.js";
import type { Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";
import {
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../step/validate-fixtures.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { encodeLine, type LiveDoRequest, type LiveRequest, type LiveResponse } from "./protocol.js";

// Responsibility: one live session's own process — everything cli/session.ts's
// `runSessionStart` spawns detached (docs/spec.md "Live sessions"). One
// `ctx` is built once, here, and held open for this process's whole life,
// so an execution lands on whatever the session's last execution left
// behind instead of a fresh world (the entire point of the feature — this
// file's own header is the "how", docs/spec.md is the "why"). Structured
// after src/run/run-scenario.ts's own shared-`ctx`, several-boundaries
// shape (`contextHandle.beginStep`/`endStep` bracket each execution,
// `dispose()` runs exactly once, at the very end) rather than cli/do.ts's
// own one-ctx-one-execution shape — do.ts's per-call teardown (fixture
// caches, `dispose()`, storageState persistence) is precisely what this
// file must *not* do per request, so its setup/execution *validations*
// (unknown step, compat step, `from`/fixture/`--use` checks, read-only
// policy) are reproduced here against this process's own long-lived
// vocabulary rather than shared with do.ts's own short-lived one.
//
// Config, discovery, secrets, and the version probe are all read once, at
// startup, and held for this process's whole life — the same "frozen for
// the run" scope `nuka do`/`nuka run` already give each of these within one
// invocation, extended here to mean one live session's own lifetime instead
// of one execution's. A project edited while a session is running is not
// picked up until the session is stopped and started again; this is a
// deliberate consequence of what a live session already is (one held-open
// world), not a gap specific to this file.
//
// The two fixture scopes need no third value here either (docs/spec.md
// "Live sessions"): `fixtureScenarioCache`/`fixtureProcessCache` are both
// created once, before the socket ever opens, and torn down once, in
// `performCleanup()`, together with `contextHandle.dispose()` — `"scenario"` scope
// lasts the whole session, `"process"` scope lasts this process, and since
// a live session's process *is* its own process, those two happen to be the
// same lifetime by construction, not a special case this file adds.
//
// One execution at a time, enforced by `busy` alone (docs/spec.md: "a
// second `do` against a busy session is refused rather than queued") —
// deliberately not a queue: an exploration is driven by something deciding
// the next call from the last result, so a caller racing a second one in
// has nothing coherent to decide from yet.
//
// Split in two: `createSessionCore` does everything above except open a
// real socket, and returns a request dispatcher (`SessionCore`) that
// already knows this session's own vocabulary, ctx, busy state, and idle
// timer. `runSessionDaemon`, below it, is the thin remainder: it opens
// the actual unix socket and feeds each connection's one line into that
// dispatcher. The split exists so the dispatcher itself (unknown-step and
// compat-step refusal, busy rejection, args/returns validation, the
// stop-then-cleanup order) can be called directly, without a socket
// connection or a process of its own to spawn and tear down.

function readOnlyDeclaredMutatesMessage(stepName: string, environment: string): string {
  return `Step "${stepName}" mutates state but environment "${environment}" has policy "read-only"`;
}

export interface RunSessionDaemonOptions {
  readonly rootDir: string;
  /** `--env`'s raw value from `session start`, or `null` when omitted —
   * resolved here the same way cli/do.ts's own setup phase resolves it, so
   * the two never disagree about which environment (hence which lock/sock/
   * session-file path) this session lives at. */
  readonly env: string | null;
  readonly name: string;
  readonly idleTimeoutMs: number;
  /** Ends this process; defaults to `process.exit`. Overridable only so an
   * in-process test can run a whole daemon (`runSessionDaemon` itself, not
   * just `createSessionCore`) and observe "the daemon decided to end
   * itself" (an idle timeout, a completed stop) without that decision
   * killing the test's own worker process. daemon-entry.ts never sets
   * this, so a real session's own behavior never depends on it. */
  readonly exit?: (code: number) => void;
}

/**
 * Everything `createSessionCore` needs beyond `RunSessionDaemonOptions`
 * itself: a hook for stopping whatever socket server its own caller is
 * running, called from `performCleanup` alone, and always fire-and-forget
 * there (that function's own comment explains why). A caller that never
 * opened a real socket, a test calling `createSessionCore` directly, has
 * nothing to close, hence the no-op default.
 */
export interface CreateSessionCoreOptions extends RunSessionDaemonOptions {
  readonly closeServer?: () => void;
}

/**
 * One live session's own request dispatcher, independent of the unix
 * socket `runSessionDaemon` normally puts in front of it: everything
 * `handleConnection` decides (unknown/compat-step refusal, busy rejection
 * for a `do` and a `stop` alike, args/returns validation, `--use`
 * resolution, and stop's cleanup-before-response order) lives here,
 * reachable with a plain request or a request-shaped wire line and nothing
 * else.
 */
export interface SessionCore {
  /** This session's own unix socket, inside a private directory `mkdtemp`
   * made under the OS's own temp directory (live-sock.ts) — never under
   * `stateDir`, and never derivable from `rootDir`/`name` the way it used
   * to be, so this is the only place `runSessionDaemon`'s own listen target
   * comes from. Also what `acquireLock` (above) already wrote into this
   * session's own lock, under `sock` — every other reader in this package
   * that needs to reach a live session reads it from there instead of
   * here. */
  readonly sockPath: string;
  /** Parses one line of wire JSON, then dispatches it exactly as
   * `dispatchRequest` would: malformed JSON is its own `"rejected"`
   * response, never a throw, the same contract `handleConnection` already
   * promises for every request this session is reached by. */
  dispatchLine(line: string): Promise<LiveResponse>;
  /** Decides and executes one already-parsed request: a `"do"` runs
   * `executeDo` (unless this session is busy), a `"stop"` runs this
   * session's own cleanup to completion and *then* returns `{ status:
   * "stopped" }` (a caller sees that value only once storageState is
   * already on disk, the same order the socket path promises its own
   * caller). Never calls `process.exit` itself: ending the process, when a
   * `"stop"` warrants it, is left to the caller (`handleConnection`'s own,
   * once its acknowledgement has actually been sent). */
  dispatchRequest(request: LiveRequest): Promise<LiveResponse>;
  /** Arms this session's own idle timer for the first time.
   * `runSessionDaemon` calls this only once its own socket is actually
   * listening (a session that cannot yet be reached is not "idle" yet
   * either), but nothing about the dispatcher itself requires a socket to
   * exist first, so a caller driving `SessionCore` directly may call this
   * as soon as it likes. */
  start(): void;
}

export type CreateSessionCoreResult = { readonly ok: true; readonly core: SessionCore } | { readonly ok: false };

const NOOP_TRACE_VERSION_WARNER = (): void => {
  // A trace format version this build cannot read is reported on stderr by
  // every other caller of collectTraceEvidence — but this process's own
  // stdio is `"ignore"` (spawn-daemon.ts), so there is no terminal for that
  // warning to reach. Dropped rather than escalated into a failure: exactly
  // the same "measurement must never break execution" rule
  // create-context.ts's own header states for a corrupt trace.zip.
};

export async function createSessionCore(options: CreateSessionCoreOptions): Promise<CreateSessionCoreResult> {
  const { rootDir, env, name, idleTimeoutMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const closeServer = options.closeServer ?? ((): void => {});

  const config = await loadConfig(rootDir);
  const resolvedEnv: ResolvedEnvironment = resolveEnvironment(
    config,
    env ?? DEFAULT_ENVIRONMENT_NAME,
    env !== null,
  );

  const lockPath = sessionLockPath(rootDir, config.stateDir, resolvedEnv.name, name);
  const sessionFile = sessionFilePath(rootDir, config.stateDir, resolvedEnv.name, name);

  // The socket lives under the OS's own temp directory, never under
  // `stateDir` (live-sock.ts's own header explains why: a project's own
  // path can be deep enough on its own to push a `stateDir`-derived path
  // over this platform's sun_path limit, and `os.tmpdir()` does not grow
  // with it). mkdtemp's own six-character suffix is what keeps this
  // directory unguessable — the socket accepts a step name and args and
  // runs them against live credentials, so it needs that property the same
  // way a stolen storageState file would.
  const sockDir = await mkdtemp(path.join(os.tmpdir(), LIVE_SOCK_DIR_PREFIX));
  // mkdtemp itself creates this directory at mode 0700 (POSIX mkdtemp(3));
  // chmod here makes that explicit rather than resting on a guarantee this
  // file's own reader has no way to see, the same posture the socket
  // file's own chmod already takes a few lines below, in
  // `runSessionDaemon`.
  await chmod(sockDir, 0o700);
  const sockPath = path.join(sockDir, LIVE_SOCK_FILE_NAME);

  /** Undoes the mkdtemp above and releases the lock together — every path
   * below that exits before this session is actually serving requests
   * acquired both, so both have to be given back together, the same
   * pairing `performCleanup` (further down) keeps for this session's whole
   * later life. */
  async function releaseLockAndSockDir(): Promise<void> {
    await releaseLock(lockPath);
    await rm(sockDir, { recursive: true, force: true });
  }

  // The lock is acquired by this process itself, not by `session start`'s
  // own short-lived parent (docs/spec.md "Live sessions": "the lock file is
  // the rendezvous, and it already exists") — a lock written with the
  // parent's own pid would be stale the instant the parent returns. `nuka
  // session start` already made a best-effort check before spawning this
  // process at all; this is the authoritative one, and the only one that
  // can actually win or lose the race against another session of the same
  // name starting at the same time. `sockPath` is written into the lock in
  // this same call (session/lock.ts's own `sock` field) — a conflict here
  // means this process never actually claimed the name, so the directory
  // just made above is removed rather than left behind for nothing to ever
  // find again.
  try {
    await acquireLock(lockPath, name, sockPath);
  } catch (error) {
    await rm(sockDir, { recursive: true, force: true });
    throw error;
  }

  const { vocabulary } = await discoverSteps(rootDir, config.featuresDir);
  const stepNameOf = new Map<Step, string>(
    [...vocabulary.entries()].flatMap(([stepName, entry]) =>
      entry.kind === "typed" ? [[entry.step, stepName] as const] : [],
    ),
  );
  const isRegisteredStep = registeredStepPredicate(stepNameOf.keys());

  const fixtureGraph: FixtureGraph = buildFixtureGraph(config);
  const fixtureDefinitionIssues = validateFixtureDefinitions(config);
  if (fixtureDefinitionIssues.length > 0) {
    // Every request this session could ever serve would fail the exact same
    // way (this is a config-wide judgment, not a per-step one) — refusing
    // to come up at all is more honest than opening a socket that can only
    // ever reject. `nuka session start`'s own bounded poll for this
    // session's lock to name a reachable socket (spawn-daemon.ts) is what
    // turns this early exit into a reported failure.
    await releaseLockAndSockDir();
    process.exitCode = 1;
    return { ok: false };
  }
  const knownFixtures = knownFixtureNames(config);

  const envFiles = resolvedEnv.envFiles;
  const envVars = loadEnvFiles(rootDir, envFiles);
  const classification = await classifyEnvFiles(rootDir, envFiles);
  const secrets: SecretSet = buildSecretSet(rootDir, {
    secretSourceFiles: classification.secretSource,
    trackedFiles: classification.tracked,
    publicKeys: config.secrets.public,
    redactKeys: config.secrets.redact,
  });

  // Probed once, like `secrets` above, and reused on every step record this
  // session ever writes — a live session's own target does not change
  // execution to execution the way `nuka do`'s own process-per-call probe
  // has to assume it might.
  const probeResult = await probeVersion(resolvedEnv.version);
  const targetVersion = probeResult?.ok ? probeResult.version : undefined;

  let loadedStorageState: Awaited<ReturnType<typeof readSessionFile>> = null;
  try {
    loadedStorageState = await readSessionFile(sessionFile, name);
  } catch {
    // A malformed session file is a setup failure `nuka do` also refuses on
    // (do.ts's own setup phase) — this session has nothing safe to restore,
    // so it must not come up silently empty instead.
    await releaseLockAndSockDir();
    process.exitCode = 1;
    return { ok: false };
  }

  const sessionsDirPath = sessionsDir(rootDir, config.stateDir, resolvedEnv.name);
  await mkdir(sessionsDirPath, { recursive: true, mode: 0o700 });

  const contextHandle: StepContextHandle = createStepContext({
    config: { ...config, baseURL: resolvedEnv.baseURL },
    // A placeholder that only has to exist until this session's first
    // execution calls `beginStep` and redirects it for real — see
    // create-context.ts's own header for why every boundary-based caller
    // (this one, run-scenario.ts) needs *some* existing directory up front.
    evidenceDir: sessionsDirPath,
    env: envVars,
    secrets,
    storageState: loadedStorageState ?? undefined,
    // No chain across this session's own executions: matches `nuka do`'s
    // own contract exactly (docs/spec.md "Context API": "undefined under
    // `nuka do`") — a live session is a sequence of `do`-shaped executions,
    // never a scenario, and `--use` is still the one way to carry a value
    // from one execution into the next, the same as it already is for a
    // plain `nuka do`.
    resultOf: () => undefined,
    isRegisteredStep,
    stepNameOf: (step) => stepNameOf.get(step),
    refuseMutatingPart: (part) =>
      resolvedEnv.policy === "read-only" && part.mutates
        ? readOnlyDeclaredMutatesMessage(
            stepNameOf.get(part) ?? "a step discovery never registered",
            resolvedEnv.name,
          )
        : undefined,
  });

  const fixtureScenarioCache = createFixtureCache();
  const fixtureProcessCache = createFixtureCache();

  // The one single-execution-slot guard (docs/spec.md "Live sessions": "one
  // execution at a time") — covers a `do` in flight *and* a stop in
  // progress alike, since tearing this session's own `ctx` down while a
  // step is still using it would be exactly the kind of thing "one thing at
  // a time" exists to prevent. Set synchronously, before this function's
  // own first `await`, by whichever of `executeDo`/`performCleanup` claims
  // it first — Node's single-threaded event loop is what makes that enough:
  // two callbacks can never interleave inside the same synchronous stretch,
  // so there is no window for both to observe `busy === false` at once.
  let busy = false;
  let executionCount = 0;
  let idleTimer: NodeJS.Timeout;

  function armIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (busy) {
        // A step is still running right at the idle boundary — this
        // session is not actually idle, so don't tear its `ctx` down out
        // from under it. Check again after another full window instead of
        // stopping now or silently never stopping at all.
        armIdleTimer();
        return;
      }
      void performCleanupAndExit();
    }, idleTimeoutMs);
  }

  /**
   * The actual teardown: fixture caches, `dispose()`, persisting
   * storageState (when there is one to persist), stopping whatever socket
   * server this caller is running (`closeServer`), removing the socket's
   * own mkdtemp'd directory, and releasing the lock: everything a caller
   * needs finished *before* it can trust the session is really gone.
   * Deliberately does
   * not call `process.exit` itself: a "stop" response is `dispatchRequest`'s
   * own return value, and its own caller (`handleConnection`) still needs
   * the process alive long enough to write its own acknowledgement back
   * over the socket first (see that function's own comment for why sending
   * the ack any earlier would race the very thing it is meant to promise).
   */
  async function performCleanup(): Promise<void> {
    busy = true;
    clearTimeout(idleTimer);

    // Fixture teardown before `dispose()`, `"scenario"` before `"process"`
    // — the same ordering do.ts's own execution phase already documents,
    // for the same reason (a fixture holding `page`/`context`/`request`
    // needs them still open during its own teardown code). Outcome is
    // always `"passed"`: several executions, possibly a mix of `"ok"` and
    // `"failed"`, shared this cache, so there is no single execution's own
    // outcome left to report by the time the session as a whole ends.
    await teardownFixtureCache(fixtureScenarioCache, "passed");
    await teardownFixtureCache(fixtureProcessCache, "passed");

    let disposeResult: Awaited<ReturnType<StepContextHandle["dispose"]>>;
    try {
      disposeResult = await contextHandle.dispose();
    } catch {
      disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
    }
    if (disposeResult.storageState !== undefined) {
      try {
        await writeSessionFile(sessionFile, disposeResult.storageState);
      } catch {
        // Persisting the session must not throw out of cleanup — same
        // fault tolerance do.ts's own save already has.
      }
    }

    // Not awaited: a real `server.close()`'s own callback only fires once
    // every connection it has ever accepted has ended, and the "stop"
    // request's own connection (the caller this cleanup is running for)
    // is deliberately still open at this point (its own acknowledgement is
    // sent right after this function returns, in `handleConnection`'s
    // `"stop"` branch). Awaiting that callback here would wait on a
    // connection this very call is what keeps open, a real deadlock this
    // file hit under test. All `close()` needs to do synchronously is stop
    // *accepting new* connections, which it already does before returning.
    closeServer();
    // Recursive here, unlike every other reader of a lock's `sock` field in
    // this package (live-sock.ts's own `removeLiveSockDir`): this process is
    // the one that created `sockDir` with `mkdtemp` a few lines up in this
    // same function, so there is nothing to protect against here that a
    // reader reconstructing the path from a lock file on disk would need
    // to.
    await rm(sockDir, { recursive: true, force: true });
    await releaseLock(lockPath);
  }

  /** The idle-timeout path: nothing is waiting on an acknowledgement, so
   * cleanup and process exit happen back to back. */
  async function performCleanupAndExit(): Promise<void> {
    await performCleanup();
    exit(0);
  }

  async function executeDo(request: LiveDoRequest): Promise<LiveResponse> {
    const entry = vocabulary.get(request.step);
    if (!entry) {
      return { status: "rejected", message: `Unknown step: ${request.step}` };
    }
    if (entry.kind === "compat") {
      return {
        status: "rejected",
        message:
          `Step "${request.step}" is a compat step and has no typed contract, so it cannot be run ` +
          "individually; promote it to defineStep to run it via `nuka do` (docs/spec.md \"What compat steps lack\")",
      };
    }

    const fromIssues = validateStepFrom(request.step, entry.step, isRegisteredStep);
    if (fromIssues.length > 0) {
      return { status: "rejected", message: formatFromIssues(fromIssues) };
    }

    const fixtureIssues = validateStepFixtures(request.step, entry.step, knownFixtures);
    if (fixtureIssues.length > 0) {
      return { status: "rejected", message: formatFixtureIssues(fixtureIssues) };
    }

    const use = request.use ?? [];
    const resolvedUses: ResolveUseSuccess[] = [];
    for (const recordId of use) {
      const resolved = resolveUse(recordId, entry.step, stepNameOf, (id) =>
        readStepRecordById(rootDir, config.stateDir, id),
      );
      if (!resolved.ok) {
        return { status: "rejected", message: resolved.message };
      }
      resolvedUses.push(resolved);
    }
    const producerByKey = new Map<string, string>();
    for (const resolved of resolvedUses) {
      for (const key of Object.keys(resolved.filled)) {
        const existingProducer = producerByKey.get(key);
        if (existingProducer !== undefined && existingProducer !== resolved.used.step) {
          return {
            status: "rejected",
            message:
              `--use: key "${key}" is filled by both step "${existingProducer}" and step ` +
              `"${resolved.used.step}". These are different candidate producers for the same ` +
              "`from` key, and this session cannot tell which one should win",
          };
        }
        producerByKey.set(key, resolved.used.step);
      }
    }

    if (resolvedEnv.policy === "read-only" && entry.step.mutates) {
      return { status: "rejected", message: readOnlyDeclaredMutatesMessage(request.step, resolvedEnv.name) };
    }

    // --- From here on a step record is always written — same "never began
    // vs. always attested" split do.ts's own header documents. ---
    const recordId = generateStepRecordId();
    const relativeDir = path.join(config.stateDir, "records", "steps", recordId);
    const evidenceDir = path.join(rootDir, relativeDir);
    await mkdir(evidenceDir, { recursive: true });

    // Opens this execution's own trace chunk (lazily, on this boundary's
    // first `ctx.page()` call) and redirects http.jsonl/`observed`/`used`/
    // etc. away from whatever the previous execution left them pointing at
    // — the run-scenario.ts pattern this file's own header describes.
    await contextHandle.beginStep(evidenceDir, request.step);

    // `--use`'s own effect, applied only now: `contextHandle.recordUsed`
    // writes into the `used` collector `beginStep` just reset, so applying
    // it any earlier would be silently wiped out.
    let parsedArgs = request.args;
    if (typeof parsedArgs === "object" && parsedArgs !== null && !Array.isArray(parsedArgs)) {
      const argsObject = parsedArgs as Record<string, unknown>;
      for (const resolved of resolvedUses) {
        let filledAnyKey = false;
        for (const [key, value] of Object.entries(resolved.filled)) {
          if (!(key in argsObject)) {
            argsObject[key] = value;
            filledAnyKey = true;
          }
        }
        if (filledAnyKey) {
          contextHandle.recordUsed(resolved.used.step_record_id, resolved.used.step, resolved.used.result);
        }
      }
    }

    const startedAt = new Date();
    let status: "ok" | "failed";
    let result: unknown;
    let errorMessage = "";
    let errorKind: ErrorKind | undefined;
    let fixtureUsage: FixtureUsageEntry[] = [];
    // Defaults to the merged-but-unvalidated value (`--use` already applied
    // above); overwritten with the schema-validated value below on success,
    // matching do.ts's own `recordedArgs` so a step record's own `args`
    // never shows a key validation actually rejected or a default
    // validation actually filled in silently, regardless of which of the
    // two `nuka do` ever reaches this step through.
    let recordedArgs: unknown = parsedArgs;

    const argsResult = strictArgsSchema(entry.step.args).safeParse(parsedArgs);
    if (!argsResult.success) {
      status = "failed";
      errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
      errorKind = "args_invalid";
    } else {
      recordedArgs = argsResult.data;
      try {
        const resolved = await resolveFixtures({
          names: stepFixtureNames(entry.step),
          graph: fixtureGraph,
          ctx: contextHandle.ctx,
          scenarioCache: fixtureScenarioCache,
          processCache: fixtureProcessCache,
          defaultTimeoutMs: config.fixtureTimeout,
        });
        fixtureUsage = resolved.usage;
        contextHandle.beginStepRun(entry.step, resolved.fixtures);
        const runResult = await entry.step.run(resolved.fixtures, argsResult.data);
        const returnsResult = entry.step.returns.safeParse(runResult);
        if (!returnsResult.success) {
          status = "failed";
          errorMessage = `returns validation failed: ${formatValidationIssues(returnsResult.error.issues)}`;
          errorKind = "result_invalid";
        } else {
          status = "ok";
          result = returnsResult.data;
        }
      } catch (error) {
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
        errorKind = "step_error";
      }
    }

    const observed = contextHandle.observedCounts();
    const sections = contextHandle.sectionsSnapshot();
    const calls = contextHandle.callsSnapshot();
    const polls = contextHandle.pollsSnapshot();
    const requiredEnv = contextHandle.envReadsSnapshot();
    const used = contextHandle.usedSnapshot();
    const pageEvents = contextHandle.pageEventsSnapshot();
    const httpOmitted = contextHandle.httpOmittedSnapshot();
    const evidenceSnapshot = await contextHandle.evidenceSnapshot();
    const finishedAt = new Date();

    // Closes this execution's own trace chunk *before* reading it back —
    // the same ordering run-scenario.ts's own `finishExecutedStep` uses,
    // and for the same reason (its own `trace` field has to be knowable
    // now, from a chunk already written to disk, not from whatever the
    // *next* `beginStep` will eventually close).
    await contextHandle.endStep();
    const traceEvidence = await collectTraceEvidence(evidenceDir, NOOP_TRACE_VERSION_WARNER);
    const truncated = mergeTruncated(traceEvidence.truncated, evidenceSnapshot.truncatedCount);

    executionCount += 1;
    const sessionExecution = executionCount;

    const evidence: EvidenceMeta = {
      dir: relativeDir,
      // Always empty: like a `nuka run` step record (run-scenario.ts's own
      // `finishExecutedStep`), this execution's own `ctx` is never disposed
      // on its own — a screenshot is only ever collected once, at this
      // whole session's own `dispose()` at cleanup time, which has no per-
      // execution step record left to attach it to.
      screenshots: [],
      ...(existsSync(path.join(evidenceDir, "http.jsonl")) ? { http: "http.jsonl" } : {}),
      ...(traceEvidence.trace !== undefined ? { trace: traceEvidence.trace } : {}),
      ...(evidenceSnapshot.attachments.length > 0 ? { attachments: evidenceSnapshot.attachments } : {}),
    };

    const stepRecord: StepRecord =
      status === "ok"
        ? {
            step_record_id: recordId,
            step: request.step,
            kind: "do",
            args: recordedArgs,
            result,
            status: "ok",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session: name,
            session_execution: sessionExecution,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence,
            observed,
            mutates: entry.step.mutates,
            ...(used.length > 0 ? { used: omitUsedResults(used) } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(calls.length > 0 ? { calls } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
          }
        : {
            step_record_id: recordId,
            step: request.step,
            kind: "do",
            args: recordedArgs,
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session: name,
            session_execution: sessionExecution,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence,
            observed,
            mutates: entry.step.mutates,
            ...(used.length > 0 ? { used } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(calls.length > 0 ? { calls } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
          };

    const redactedStepRecord = redact(stepRecord, secrets) as StepRecord;
    await writeStepRecord(evidenceDir, redactedStepRecord);
    return { status: "record", record: redactedStepRecord };
  }

  /**
   * Given an already-parsed request, decides busy/rejection and dispatches
   * to `executeDo` or to this session's own cleanup: the exact decision
   * `handleConnection` used to make inline before ever writing a response.
   * `busy` is claimed synchronously, before this function's own first
   * `await`, in both the `"do"` branch below and inside `performCleanup`
   * itself (that function's own header), the same "no window for both to
   * observe `busy === false` at once" property this file's own top header
   * already documents for the `busy` flag as a whole.
   */
  async function dispatchRequest(request: LiveRequest): Promise<LiveResponse> {
    if (request.kind === "stop") {
      if (busy) {
        const response: LiveResponse = {
          status: "rejected",
          message: `session "${name}" is busy executing another step; try again once it finishes`,
        };
        // A refused request is still a request this session was reached by
        // (docs/spec.md "an idle timeout applies... because a forgotten
        // session is the normal outcome"): a caller retrying a wrong step
        // name, or racing a `stop` against an in-flight `do`, is present
        // and working, not idle. Re-arming here, and at every other place
        // this function returns, is what keeps the countdown measuring
        // silence rather than success.
        armIdleTimer();
        return response;
      }
      // Cleanup (storageState persisted, socket/lock removed) runs to
      // completion *before* this function returns `{ status: "stopped" }`:
      // a caller that sees that value needs it to mean the session's own
      // ending state is already on disk, not merely "about to be". Ending
      // this process, once that caller's own acknowledgement has actually
      // been sent, is `handleConnection`'s own job below, deliberately not
      // this function's (its own header explains why).
      await performCleanup();
      return { status: "stopped" };
    }

    if (busy) {
      const response: LiveResponse = {
        status: "rejected",
        message: `session "${name}" is busy executing another step; only one execution runs at a time`,
      };
      armIdleTimer();
      return response;
    }

    busy = true;
    try {
      return await executeDo(request);
    } finally {
      busy = false;
      // Re-armed for every request this function finishes, not only a
      // `"record"` — a step named wrong, or one that fails `from`/fixture
      // validation, is still someone actively exploring against this
      // session; tearing it down under them because they mistyped a step
      // name would be a surprise worse than the timeout it was meant to
      // prevent. The socket only ever takes local, 0600-gated connections,
      // so nothing outside this session's own caller can spend this re-arm
      // to keep the process alive against its owner's wishes.
      armIdleTimer();
    }
  }

  /** `dispatchRequest`, but starting from one still-unparsed wire line:
   * the same "parse, then dispatch" split `handleConnection` performs
   * before ever writing a response. Malformed JSON is its own `"rejected"`
   * response and, deliberately like every other transport-level failure
   * `handleConnection` used to handle before ever reaching `busy`, never
   * touches `busy` or the idle timer at all. */
  async function dispatchLine(line: string): Promise<LiveResponse> {
    let request: LiveRequest;
    try {
      request = JSON.parse(line) as LiveRequest;
    } catch (error) {
      return {
        status: "rejected",
        message: `malformed request JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return dispatchRequest(request);
  }

  return {
    ok: true,
    core: { sockPath, dispatchLine, dispatchRequest, start: armIdleTimer },
  };
}

/**
 * One socket connection's own lifecycle: read its one line, dispatch it
 * through `core`, and write back the one response line. For an accepted
 * `"stop"` (`core.dispatchRequest`'s own header: cleanup has already
 * finished by the time that response exists), this process ends only once
 * the acknowledgement has actually finished writing (the callback to
 * `socket.end`, not merely the call returning), since ending it any
 * earlier risks truncating the very bytes the caller is waiting to read.
 */
async function handleConnection(socket: net.Socket, core: SessionCore, exit: (code: number) => void): Promise<void> {
  const line = await readOneLine(socket);
  if (line === undefined) {
    socket.destroy();
    return;
  }

  const response = await core.dispatchLine(line);
  if (response.status === "stopped") {
    await new Promise<void>((resolve) => {
      socket.end(encodeLine(response), () => resolve());
    });
    exit(0);
    return;
  }
  socket.end(encodeLine(response));
}

/**
 * `nuka session start`'s own detached child, in full: builds this
 * session's own dispatcher (`createSessionCore`, above) and puts a real
 * unix socket in front of it, one connection at a time (`handleConnection`,
 * above). `daemon-entry.ts` is this function's only real caller; a caller
 * wanting the dispatcher alone, without a socket or a process of its own,
 * calls `createSessionCore` directly instead.
 */
export async function runSessionDaemon(options: RunSessionDaemonOptions): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let server: net.Server;
  const result = await createSessionCore({ ...options, exit, closeServer: () => server.close() });
  if (!result.ok) {
    return;
  }
  const core = result.core;

  server = net.createServer((socket) => {
    handleConnection(socket, core, exit).catch(() => {
      socket.destroy();
    });
  });

  // No stale-file removal before `listen()` here any more: `core.sockPath`
  // sits inside a directory `mkdtemp` just made fresh, a few lines up in
  // `createSessionCore`, so nothing could already be there to remove.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(core.sockPath, resolve);
  });
  // `net.createServer`'s own `listen()` creates the socket file with a
  // umask-derived mode, never 0600 on its own — this session's socket
  // carries live credentials the same way its storageState file does
  // (docs/spec.md "Live sessions"), so it needs the same explicit `chmod`
  // that file already gets (session/store.ts's own `writeSessionFile`).
  await chmod(core.sockPath, 0o600);

  core.start();
}

/**
 * Reads one `\n`-terminated line off `socket` and returns it without the
 * trailing newline — `undefined` if the socket closes or errors before a
 * full line ever arrives. Only the first line is read; anything after it in
 * the same `data` event is discarded, matching this protocol's own "one
 * connection, one request" rule (protocol.ts's own header).
 */
function readOneLine(socket: net.Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    function finish(value: string | undefined): void {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      resolve(value);
    }
    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        finish(buffer.slice(0, newlineIndex));
      }
    }
    function onError(): void {
      finish(undefined);
    }
    function onClose(): void {
      finish(undefined);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
