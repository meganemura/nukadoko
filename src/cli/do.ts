import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { formatValidationIssues } from "../binding/format-issues.js";
import { loadConfig } from "../config/load-config.js";
import { createStepContext, type DisposeResult } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
import { mergeTruncated } from "../context/evidence.js";
import { collectTraceEvidence, createTraceVersionWarner } from "../context/trace-actions.js";
import { omitUsedResults } from "../context/used.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { probeVersion } from "../environment/probe-version.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import {
  createFixtureCache,
  resolveFixtures,
  teardownFixtureCache,
  type FixtureUsageEntry,
} from "../fixture/resolver.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { sendLiveRequest } from "../live/client.js";
import { removeLiveSockDir } from "../live/live-sock.js";
import { generateStepRecordId } from "../record/record-id.js";
import { readStepRecordById } from "../record/read-step-record.js";
import { retentionNote } from "../record/retention.js";
import type { ErrorKind, StepRecord } from "../record/types.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import { acquireLock, liveLockOwner, readLockInfo, releaseLock } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionFilePath, sessionLockPath } from "../session/paths.js";
import { readSessionFile, writeSessionFile } from "../session/store.js";
import type { Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../step/validate-fixtures.js";
import { formatFromIssues, registeredStepPredicate, validateStepFrom } from "../step/validate-from.js";
import { resolveUse, type ResolveUseSuccess } from "./resolve-use.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka do`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as vocabulary.ts).
// Two phases, matching docs/spec.md's "Running"/"Records" split exactly:
//
//   1. Setup — malformed --args JSON, an unknown step name, a config/
//      discovery error, an unknown `--env` name, a mutating step against a
//      `policy: "read-only"` environment, an invalid `--session` name, a
//      lock held by another live process, a malformed session file, a bad
//      `--use <record-id>` (unknown id, a non-`"ok"` step record, a step
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
//      throw is `status: "ok"`. The setup phase's read-only refusal above
//      only ever sees the step's *declared* `mutates`, and that declaration
//      is trusted — an otherwise-"ok" run
//      that observed a network write in a read-only environment is no
//      longer demoted for it; `record.observed` still records what
//      happened, it just doesn't decide `status` any more. `--use`'s own
//      values, already resolved and validated in setup above, are actually
//      applied here — merged into `parsedArgs` (`--args` still wins for a
//      key it already set) and recorded into `used` through the same
//      collector `ctx.resultOf` writes into — because that collector only
//      exists once `contextHandle` does.
//
// `--env` is resolved (environment/resolve-environment.ts) right after
// config loads and before anything session-related, because session paths
// are now per-environment — the resolved
// environment's name, not the raw `--env` string, is what every later
// cache/sessions/<env>/ path uses. The version probe runs once, at the very top of
// the execution phase: metadata about the target, never
// reachable from a step's own `run`, and its failure/timeout never fails the
// run — only `target_version` is omitted, with one stderr warning line.
//
// The evidence-collecting side of ctx (browser/http/trace) is created and
// disposed here, never handed to the step itself — see
// context/create-context.ts's header for why that split exists. Sessions
// follow the same rule: this module is the only place a *non-live*
// session's file is actually read or written; `--session`'s lock is
// acquired right after it passes setup's name/config checks and is always
// released in `finally`, covering every return path below it.
//
// A `--session` naming a live session (docs/spec.md "Live sessions") never
// reaches any of that: `delegateToLiveSession`, below, is checked for right
// where the lock would otherwise be acquired, and on a live owner with a
// socket, this file's own setup/execution phases never run at all — the
// whole rest of this module exists only for the fresh-`ctx` path, live or
// not.
//
// This is also the one place a run's SecretSet is built and the one place a
// step record gets redacted:
// env is loaded and classified at the top of the execution phase against the
// *effective* envFiles (top-level + the resolved environment's own), and
// the finished step record is redacted
// once, as a whole object, before either record.json or the stdout copy is
// written from it — never twice, independently, which could let the two
// drift apart.

/** The declared-mutates read-only refusal message: matches run-scenario.
 * ts's own `readOnlyDeclaredMutatesMessage` wording exactly, since this is
 * the same fact about the same policy, just reached from `nuka do` this
 * time. `stepName` names whichever `Step` is actually refused — the entry
 * step named on the command line (this file's own setup-phase check,
 * below), or a part `ctx.call` refuses on that step's behalf
 * (`refuseMutatingPart`, passed to `createStepContext`) — so both refusals
 * read as the same fact about the same policy, only reached a different
 * way. */
function readOnlyDeclaredMutatesMessage(stepName: string, environment: string): string {
  return `Step "${stepName}" mutates state but environment "${environment}" has policy "read-only"`;
}

/**
 * Hands one execution to a live session's own daemon instead of building a
 * fresh `ctx` (docs/spec.md "Live sessions") — the *entire* rest of this
 * file's own setup/execution phases are skipped for this call: the daemon
 * already discovered its own vocabulary at `session start` and re-validates
 * everything this file's own setup phase would (unknown step, compat step,
 * `from`/fixture/`--use` issues, read-only policy) against it, so nothing
 * here is checked twice. `sessionPid` only ever appears in this function's
 * own transport-failure message — a rejection the daemon itself sends back
 * (`response.status === "rejected"`) needs no pid, since it already came
 * from the right process; a pid is only worth naming when the *connection
 * itself* failed and the caller has nothing else to point at.
 */
async function delegateToLiveSession(
  sockPath: string,
  sessionPid: number,
  sessionName: string,
  stepName: string,
  args: unknown,
  use: readonly string[],
  stdout: WritableSink,
  stderr: WritableSink,
): Promise<number> {
  const outcome = await sendLiveRequest(sockPath, {
    kind: "do",
    step: stepName,
    args,
    ...(use.length > 0 ? { use } : {}),
  });

  if (!outcome.ok) {
    stderr.write(
      `Session "${sessionName}" is live (pid ${sessionPid}) but connecting to it failed: ${outcome.message}\n`,
    );
    return 1;
  }

  const { response } = outcome;
  switch (response.status) {
    case "record":
      // The one line saying which world this ran in (docs/spec.md "Live
      // sessions": "a record from a live session must not read like a
      // record from a clean one") — said here, at the moment the caller can
      // still act on it, not left for a later read of `session_execution`
      // on the record itself. stdout stays the step record's JSON alone, so
      // a caller piping stdout to `jq` never has to filter this line out.
      stderr.write(
        `Session "${sessionName}" is live (pid ${sessionPid}); this step ran against it as execution #${response.record.session_execution}\n`,
      );
      stdout.write(`${JSON.stringify(response.record, null, 2)}\n`);
      return response.record.status === "ok" ? 0 : 1;
    case "rejected":
      stderr.write(
        `Session "${sessionName}" is live (pid ${sessionPid}) but refused this request: ${response.message}\n`,
      );
      return 1;
    case "stopped":
      // Unreachable in practice — a `kind: "do"` request never gets a
      // `"stopped"` response (only `cli/session.ts`'s own `kind: "stop"`
      // does). Handled anyway so this switch stays exhaustive rather than
      // silently falling through if protocol.ts's own union ever changes.
      stderr.write(`Session "${sessionName}" stopped instead of executing "${stepName}"\n`);
      return 1;
  }
}

export interface RunDoOptions {
  rootDir: string;
  name: string;
  argsJson: string;
  /** Carries login state across `do` calls as Playwright storageState;
   * `null` means a clean start — no session file is read or written
   * (docs/spec.md "Sessions..."). */
  session: string | null;
  /** `--env`'s value, or `null` when it was omitted. `null` is not the same
   * as the string `"default"`: it is what tells resolveEnvironment() not to
   * require a matching `environments` entry.
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
  const { rootDir, name, argsJson, session, env, use, stdout, stderr } = options;

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
  // requirement" — see
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
  // decided. `lockPath` stays `null`
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

    // A live session's own daemon (docs/spec.md "Live sessions") holds this
    // lock for as long as it runs, not just for one execution's own
    // duration the way a plain `--session` lock below already does — a
    // live owner *with* a `sock` (session/lock.ts's own field, written only
    // by that daemon) is that daemon, and this execution is handed to it
    // instead of building a fresh `ctx`. A live owner with no `sock` is the
    // pre-existing case this file always had (another `do --session`
    // mid-flight, whose own one-execution-long lock never names a socket at
    // all): falling through to `acquireLock` below reproduces that exact
    // conflict, unchanged.
    const owner = await liveLockOwner(lockPath);
    if (owner !== null && owner.sock !== undefined && existsSync(owner.sock)) {
      return await delegateToLiveSession(owner.sock, owner.pid, session, name, parsedArgs, use, stdout, stderr);
    }
    if (owner === null) {
      // No live owner: a stale lock, if one is still on disk, might still
      // name a socket from a daemon that is gone (idle timeout, crash)
      // without cleaning up after itself. That is evidence worth saying out
      // loud, not just fixing quietly — a socket nobody is listening on any
      // more is the trace of an exploration that stopped existing without
      // anyone telling this caller (docs/spec.md "Live sessions": "clean
      // them up before proceeding down the existing path"). The stale lock
      // *file* itself is already handled by `acquireLock` below (session/
      // lock.ts), so only its socket's own directory needs clearing here.
      const staleInfo = await readLockInfo(lockPath);
      if (staleInfo?.sock !== undefined && existsSync(staleInfo.sock)) {
        stderr.write(
          `Session "${session}"'s socket is left over from a session that is no longer live (idle timeout or crash); removing it\n`,
        );
        await removeLiveSockDir(staleInfo.sock);
      }
    }

    try {
      await acquireLock(lockPath, session);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    // The other half of "which world did this run in" (see
    // `delegateToLiveSession`'s own stderr line for the live half): said
    // here, once the fresh path is actually committed to (after the lock
    // acquisition above succeeds), so a caller mid-exploration is never
    // left assuming a session is still live when it silently stopped being
    // one.
    stderr.write(
      `Session "${session}" is not live; running this step in a fresh browser, from its saved state\n`,
    );
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
      // Compat-origin parameter types are
      // irrelevant to `nuka do`, which only ever names one step by its
      // vocabulary key.
      ({ vocabulary } = await discoverSteps(rootDir, config.featuresDir));
    } catch (error) {
      stderr.write(`${formatVocabularyError(error)}\n`);
      return 1;
    }

    const entry = vocabulary.get(name);
    if (!entry) {
      stderr.write(`Unknown step: ${name}\n`);
      return 1;
    }

    // `nuka do` cannot name a compat
    // step by name — a compat step has no typed contract (no args/returns
    // schema, no validated result), so there is nothing for `nuka do` to
    // validate or run in isolation (docs/spec.md "What compat steps lack").
    // This is a setup failure, not an execution one: no step record is written.
    if (entry.kind === "compat") {
      stderr.write(
        `Step "${name}" is a compat step and has no typed contract, so it cannot be run individually; promote it to defineStep to run it via \`nuka do\` (docs/spec.md "What compat steps lack")\n`,
      );
      return 1;
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
      stderr.write(`${formatFromIssues(fromIssues)}\n`);
      return 1;
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
      stderr.write(`${formatFixtureIssues(fixtureIssues)}\n`);
      return 1;
    }

    // The `config.fixtures` *definitions* themselves — same three findings
    // `nuka check` reports (cycles, a
    // `"process"`-scope fixture depending on a `"scenario"`-scope one, an
    // unowned `page` override), refused here before execution the same way
    // `fixtureIssues` above already is.
    const fixtureDefinitionIssues = validateFixtureDefinitions(config);
    if (fixtureDefinitionIssues.length > 0) {
      stderr.write(`${formatFixtureDefinitionIssues(fixtureDefinitionIssues)}\n`);
      return 1;
    }

    // `--use <record-id>` (docs/spec.md "Single steps
    // (the agent path)") — resolved fully here, in setup: an unknown id, a
    // non-`"ok"` step record, a step record whose step names none of this
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
        stderr.write(`${resolved.message}\n`);
        return 1;
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
          stderr.write(
            `--use: key "${key}" is filled by both step "${existingProducer}" and step ` +
              `"${resolved.used.step}". These are different candidate producers for the same ` +
              `\`from\` key, and \`nuka do\` cannot tell which one should win\n`,
          );
          return 1;
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
      stderr.write(`${readOnlyDeclaredMutatesMessage(name, resolvedEnv.name)}\n`);
      return 1;
    }

    // --- Execution phase: a step record is always written from here on. ---
    const recordId = generateStepRecordId();
    const relativeDir = path.join(config.stateDir, "records", "steps", recordId);
    const evidenceDir = path.join(rootDir, relativeDir);
    await mkdir(evidenceDir, { recursive: true });

    // The version probe runs first in the execution phase: it is metadata
    // about the target the tool records
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
    // once here (which of those same envFiles are secret sources, per git);
    // a classification failure (no git,
    // rootDir outside a repository) is itself handled inside
    // classifyEnvFiles by falling back to "everything is a secret source",
    // so it never surfaces here as a reason to fail this run. `envFiles`
    // here is the *effective* list — top-level plus the resolved
    // environment's own, later-wins
    // — not just the top-level config's.
    const envFiles = resolvedEnv.envFiles;
    const envVars = loadEnvFiles(rootDir, envFiles);
    const classification = await classifyEnvFiles(rootDir, envFiles);
    const secrets = buildSecretSet(rootDir, {
      secretSourceFiles: classification.secretSource,
      trackedFiles: classification.tracked,
      publicKeys: config.secrets.public,
      redactKeys: config.secrets.redact,
    });

    const contextHandle = createStepContext({
      // Only `baseURL` is overridden from the resolved environment: every
      // other config field (featuresDir, stateDir, browser, ...) has no
      // per-environment counterpart.
      config: { ...config, baseURL: resolvedEnv.baseURL },
      evidenceDir,
      env: envVars,
      secrets,
      storageState: loadedStorageState ?? undefined,
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
          ? readOnlyDeclaredMutatesMessage(
              stepNameOf.get(part) ?? "a step discovery never registered",
              resolvedEnv.name,
            )
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

    let status: "ok" | "failed";
    let result: unknown;
    let errorMessage = "";
    // Classified at each branch
    // that already knows *why* the step failed, not by inspecting the
    // message afterward. `nuka do` only ever runs a typed step (compat is
    // refused in setup, above) — a typed step's `run(fixtures, args)` never
    // receives `this` and has no timeout mechanism, so its own throw is
    // always `"step_error"` here, never `world_invalid`/`timeout` (those are
    // only reachable from a compat step's/hook's own execution, src/run/
    // run-scenario.ts).
    let errorKind: ErrorKind | undefined;
    // Every `config.fixtures` entry this step's own bag actually resolved —
    // `[]` (hence omitted on the step record)
    // when args validation failed before fixture resolution ever ran.
    let fixtureUsage: FixtureUsageEntry[] = [];
    // Defaults to the merged-but-unvalidated value (`--use` already applied
    // above); overwritten with the schema-validated value below on success,
    // so a step record's own `args` never shows a key validation actually
    // rejected or a default validation actually filled in silently.
    let recordedArgs: unknown = parsedArgs;

    const argsResult = strictArgsSchema(entry.step.args).safeParse(parsedArgs);
    if (!argsResult.success) {
      status = "failed";
      errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
      errorKind = "args_invalid";
    } else {
      recordedArgs = argsResult.data;
      try {
        // Bag construction happens inside this try, same as the `run()`
        // call itself below (this also resolves `config.fixtures`
        // entries): a step that names `page`
        // only launches the browser here, never earlier, and a launch
        // failure, a fixture setup failure, or a fixture use()-contract
        // violation are all a step failure ("step_error") this same way,
        // the same outcome a step's own `ctx.page()` throwing used to
        // produce when that call lived inside `run()`. `stepFixtureNames`
        // (src/step/step-fixture-names.ts) is `fixtureParameterNames` closed
        // transitively over `entry.step.parts` (docs/spec.md "Parts") — a
        // part that reaches for `page` gets the browser open here too,
        // before `run()` starts. Memoized and already validated in setup
        // above, so it is not expected to throw here.
        const resolved = await resolveFixtures({
          names: stepFixtureNames(entry.step),
          graph: fixtureGraph,
          ctx: contextHandle.ctx,
          scenarioCache: fixtureScenarioCache,
          processCache: fixtureProcessCache,
          defaultTimeoutMs: config.fixtureTimeout,
        });
        fixtureUsage = resolved.usage;
        const fixtures = resolved.fixtures;
        // Opens this step's own root call frame and hands `ctx.call` the
        // exact bag any part it calls (direct or nested) subsets from
        // (docs/spec.md "Parts") — must run before `entry.step.run` so
        // `ctx.call` is ready the moment the step's own body could reach
        // for it.
        contextHandle.beginStepRun(entry.step, fixtures);
        const runResult = await entry.step.run(fixtures, argsResult.data);
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

    // A read-only environment already refused a *declared* mutator above, in
    // setup, before anything ran; a step that declared `mutates: false` yet
    // wrote over the wire anyway is no longer demoted for it here —
    // the declaration is trusted, and
    // `observed` below still records what actually happened, for a report
    // to catch a wrong declaration after the fact.
    const observed = contextHandle.observedCounts();
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
    // Application-specific evidence `evidence.attach`/`.path` produced this
    // execution, read the same "after execution, whatever
    // its outcome" way as every other snapshot above — a `path()`-allocated
    // file is confirmed to exist right here, on disk, so this needs neither
    // a browser nor `dispose()` to have already run.
    const evidenceSnapshot = await contextHandle.evidenceSnapshot();

    const finishedAt = new Date();

    // Fixture teardown — *before*
    // `contextHandle.dispose()` just below: a fixture built off `page`/
    // `context`/`request` needs those still open while its own teardown
    // code runs. `"scenario"` scope tears down before `"process"` scope
    // only for symmetry with `nuka run`'s own ordering (src/run/
    // run-scenario.ts, cli/run.ts) — under `nuka do` both caches hold this
    // one execution's own fixtures, so there is no cross-cache dependency
    // either order could get wrong. Never changes `status` — see src/
    // fixture/resolver.ts's own `teardownFixtureCache`; a failure is
    // announced on stderr below instead (`nuka do` writes no
    // `ScenarioRecord` to carry a `teardown_errors` field on).
    const fixtureOutcome = status === "ok" ? "passed" : "failed";
    const fixtureTeardownErrors = [
      ...(await teardownFixtureCache(fixtureScenarioCache, fixtureOutcome)),
      ...(await teardownFixtureCache(fixtureProcessCache, fixtureOutcome)),
    ];
    for (const teardownError of fixtureTeardownErrors) {
      stderr.write(`Warning: fixture "${teardownError.fixture}" teardown failed: ${teardownError.message}\n`);
    }

    let disposeResult: DisposeResult;
    try {
      // No status argument — see
      // create-context.ts's own `dispose` doc comment for why.
      disposeResult = await contextHandle.dispose();
    } catch {
      // Last resort: browser-evidence.ts and create-context.ts's own dispose
      // already swallow their teardown failures, but this catch is the final
      // backstop so a failure neither of them anticipated still can't take
      // the step record down with it (docs/spec.md "Records": a step record is
      // written for every execution that started). No evidence file is known
      // to exist in that case, so none is listed, and there is nothing to
      // persist for the session either.
      disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
    }
    const { evidence, storageState: storageStateToPersist } = disposeResult;
    // `dispose()` above is what closes this execution's own (only) trace
    // chunk, if `ctx.page()` was ever called (create-context.ts's own
    // `closeCurrentChunk`) — trace.zip, when it exists at all, is fully
    // written by the time this runs, so `actions`/`truncated` can be read
    // out of it here.
    const traceEvidence = await collectTraceEvidence(evidenceDir, createTraceVersionWarner(stderr));
    // Combines `traceEvidence`'s own `{ actions }` truncation with
    // `evidenceSnapshot`'s into the step record's single
    // top-level `truncated` field — see `mergeTruncated`'s own doc comment
    // (src/context/evidence.ts) for why this is one shared function rather
    // than two independent spreads.
    const truncated = mergeTruncated(traceEvidence.truncated, evidenceSnapshot.truncatedCount);

    // Save whenever a session was requested *and* dispose() actually
    // produced something to persist: a run
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
        // Persisting the session must not cost the step record, mirroring
        // dispose()'s own fault tolerance above; a write failure here just
        // leaves the session's previous file (if any) in place.
      }
    }

    const stepRecord: StepRecord =
      status === "ok"
        ? {
            step_record_id: recordId,
            step: name,
            kind: "do",
            args: recordedArgs,
            result,
            status: "ok",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence: {
              dir: relativeDir,
              ...evidence,
              ...(evidenceSnapshot.attachments.length > 0 ? { attachments: evidenceSnapshot.attachments } : {}),
            },
            observed,
            mutates: entry.step.mutates,
            // `omitUsedResults`: an
            // "ok" step record keeps `used`'s original `{ step_record_id, step }`
            // shape — see the failed branch just below for the case that keeps
            // the upstream's own result.
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
            step: name,
            kind: "do",
            args: recordedArgs,
            // `errorKind` is always set by this point: `status` only ever
            // becomes `"failed"` alongside it, at each branch above. The
            // `?? "step_error"` fallback is a
            // belt-and-braces default, falling back to `step_error`
            // whenever the classification is
            // ambiguous — it should never actually be reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session,
            scenario_record_id: null,
            run_id: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            mutates: entry.step.mutates,
            evidence: {
              dir: relativeDir,
              ...evidence,
              ...(evidenceSnapshot.attachments.length > 0 ? { attachments: evidenceSnapshot.attachments } : {}),
            },
            observed,
            // Unstripped here, unlike the "ok" branch above: a failed
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
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
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
    return status === "ok" ? 0 : 1;
  } finally {
    // Released regardless of which path above returned — setup failure,
    // execution failure, or success: always
    // released when execution ends.
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
