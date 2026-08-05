import { mkdir } from "node:fs/promises";
import path from "node:path";
import { formatValidationIssues } from "../binding/format-issues.js";
import { loadConfig } from "../config/load-config.js";
import { createStepContext, type DisposeResult } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
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
import { generateReceiptId } from "../receipt/receipt-id.js";
import { readReceiptById } from "../receipt/read-receipt.js";
import type { ErrorKind, Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionFilePath, sessionLockPath } from "../session/paths.js";
import { readSessionFile, writeSessionFile } from "../session/store.js";
import type { Step } from "../step/define-step.js";
import { fixtureParameterNames } from "../step/fixture-names.js";
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
// Two phases, matching docs/spec.md's "Running"/"Receipts" split exactly:
//
//   1. Setup — malformed --args JSON, an unknown step name, a config/
//      discovery error, an unknown `--env` name, a mutating step against a
//      `policy: "read-only"` environment, an invalid `--session` name, a
//      lock held by another live process, a malformed session file, a bad
//      `--use <receipt-id>` (unknown id, a non-`"ok"` receipt, a receipt
//      whose step names none of this step's `from` entries, or a missing
//      result key — m6c-do-use task spec), or two `--use` values filling the
//      same `from` key from two different candidate producers (m7a-from-
//      alternatives task spec, item 4 — the one ambiguity a scenario's own
//      from-order guard would refuse that `nuka do` has no such guard to
//      catch by itself). None of these write a receipt: the run never
//      started, so there is nothing to attest to (a receipt for an execution
//      that never began would let a nonexistent run be cited later as if it
//      had happened).
//   2. Execution — from here a receipt is always written, whatever
//      happens: args schema failure, the step's own throw, and returns
//      schema failure are all `status: "failed"` with `error.message`; only
//      a step whose args and returns both validate and whose `run` doesn't
//      throw is `status: "ok"`. The setup phase's read-only refusal above
//      only ever sees the step's *declared* `mutates`, and that declaration
//      is trusted (t2-trust-declaration task spec) — an otherwise-"ok" run
//      that observed a network write in a read-only environment is no
//      longer demoted for it; `receipt.observed` still records what
//      happened, it just doesn't decide `status` any more. `--use`'s own
//      values, already resolved and validated in setup above, are actually
//      applied here — merged into `parsedArgs` (`--args` still wins for a
//      key it already set) and recorded into `used` through the same
//      collector `ctx.resultOf` writes into (m6a-from-core task spec, item
//      5) — because that collector only exists once `contextHandle` does.
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
  /** Carries login state across `do` calls as Playwright storageState;
   * `null` means a clean start — no session file is read or written
   * (docs/spec.md "Sessions..."). */
  session: string | null;
  /** `--env`'s value, or `null` when it was omitted. `null` is not the same
   * as the string `"default"`: it is what tells resolveEnvironment() not to
   * require a matching `environments` entry (this task's spec, decision 2).
   */
  env: string | null;
  /** `--use <receipt-id>` (repeatable), in the order given (m6c-do-use task
   * spec; docs/spec.md "Single steps (the agent path)"): each fills whichever
   * of this step's own `from` keys that receipt's step is named by. Empty
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
      // Compat-origin parameter types (m2a-compat-registry task spec) are
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

    // m2a-compat-registry task spec, item 5: `nuka do` cannot name a compat
    // step by name — a compat step has no typed contract (no args/returns
    // schema, no validated result), so there is nothing for `nuka do` to
    // validate or run in isolation (docs/spec.md "What compat steps lack").
    // This is a setup failure, not an execution one: no receipt is written.
    if (entry.kind === "compat") {
      stderr.write(
        `Step "${name}" is a compat step and has no typed contract, so it cannot be run individually; promote it to defineStep to run it via \`nuka do\` (docs/spec.md "What compat steps lack")\n`,
      );
      return 1;
    }

    // Built once, from this same vocabulary — the "Step object -> the name
    // discovery registered it under" map both `isRegisteredStep` just below
    // and `--use`'s own step-name match (m6c-do-use task spec) need, so this
    // walks `vocabulary` once rather than twice for the two questions.
    const stepNameOf = new Map<Step, string>(
      [...vocabulary.entries()].flatMap(([stepName, vocabularyEntry]) =>
        vocabularyEntry.kind === "typed" ? [[vocabularyEntry.step, stepName] as const] : [],
      ),
    );
    // The "is this Step object one discovery actually registered" predicate
    // both `from`'s own structural check just below and `ctx.resultOf`'s
    // unregistered-Step throw (wired into createStepContext further down)
    // need (m6a-from-core task spec, items 3, 6).
    const isRegisteredStep = registeredStepPredicate(stepNameOf.keys());

    // `from`'s own structural validation (m6a-from-core task spec, item 3;
    // docs/spec.md "Chaining steps": "run/do refuse to execute the step at
    // all") — an unregistered upstream, an args/returns key `from` names
    // that doesn't actually exist, or an upstream that isn't even a Step.
    // Fatal like ConfigError/DuplicateStepError above: this step's execution
    // never began, so no receipt is written for it.
    const fromIssues = validateStepFrom(name, entry.step, isRegisteredStep);
    if (fromIssues.length > 0) {
      stderr.write(`${formatFromIssues(fromIssues)}\n`);
      return 1;
    }

    // The fixture-bag counterpart to the `from` structural check just above
    // (p4a-fixture-bag task spec, scope item 3): an unknown fixture name, or
    // a `run()` whose first argument isn't a plain object-destructuring
    // pattern at all, refuses this step's execution before it ever begins —
    // `nuka check` runs this exact same judgment (src/check/analyze.ts) over
    // the whole vocabulary, so a step never passes `nuka check` and then
    // fails this refusal, or the reverse. `knownFixtureNames(config)`
    // widens the closed builtin-only set to builtins ∪ `config.fixtures`
    // (P5 task spec, scope item 5).
    const fixtureGraph = buildFixtureGraph(config);
    const fixtureIssues = validateStepFixtures(name, entry.step, knownFixtureNames(config));
    if (fixtureIssues.length > 0) {
      stderr.write(`${formatFixtureIssues(fixtureIssues)}\n`);
      return 1;
    }

    // The `config.fixtures` *definitions* themselves (P5 task spec, scope
    // item 8) — same three findings `nuka check` reports (cycles, a
    // `"process"`-scope fixture depending on a `"scenario"`-scope one, an
    // unowned `page` override), refused here before execution the same way
    // `fixtureIssues` above already is.
    const fixtureDefinitionIssues = validateFixtureDefinitions(config);
    if (fixtureDefinitionIssues.length > 0) {
      stderr.write(`${formatFixtureDefinitionIssues(fixtureDefinitionIssues)}\n`);
      return 1;
    }

    // `--use <receipt-id>` (m6c-do-use task spec; docs/spec.md "Single steps
    // (the agent path)") — resolved fully here, in setup: an unknown id, a
    // non-`"ok"` receipt, a receipt whose step names none of this step's
    // `from` entries, or a missing result key are each a setup failure, the
    // same family as the `from` structural check just above. Only
    // validated/read here, not yet applied — applying it (and recording it
    // into `used`) has to wait for the execution phase below, where
    // `contextHandle`'s own collector (m6a-from-core task spec, item 5)
    // actually exists; this loop just fails fast before anything is written
    // if any `--use` value is bad.
    const resolvedUses: ResolveUseSuccess[] = [];
    for (const receiptId of use) {
      const resolved = resolveUse(receiptId, entry.step, stepNameOf, (id) =>
        readReceiptById(rootDir, config.stateDir, id),
      );
      if (!resolved.ok) {
        stderr.write(`${resolved.message}\n`);
        return 1;
      }
      resolvedUses.push(resolved);
    }

    // m7a-from-alternatives task spec, item 4's second bullet: a key naming
    // several candidate producers can be filled by two different `--use`
    // values that each matched a *different* one of those candidates — the
    // same ambiguity a scenario's own from-order guard (src/check/from-
    // order.ts) refuses, but `nuka do` never runs that check (it has no
    // scenario, no pickle, nothing for `checkFromOrder` to walk), so this is
    // the only place left to catch it. Every key filled by more than one
    // `resolvedUses` entry must trace back to the *same* producer step
    // (`resolved.used.step`, already the receipt's own step name — every key
    // one `resolveUse` call fills comes from that one receipt, so it is also
    // that fill's own candidate producer); two different producers for one
    // key is refused here, before anything is written. Two different
    // receipts of the *same* producer filling the same key is a different,
    // pre-existing case (this task's spec: unrelated, unchanged) — the
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
    const secrets = buildSecretSet(rootDir, {
      secretSourceFiles: classification.secretSource,
      trackedFiles: classification.tracked,
      publicKeys: config.secrets.public,
      redactKeys: config.secrets.redact,
    });

    const contextHandle = createStepContext({
      // Only `baseURL` is overridden from the resolved environment: every
      // other config field (featuresDir, stateDir, browser, ...) has no
      // per-environment counterpart (this task's spec, decision 3).
      config: { ...config, baseURL: resolvedEnv.baseURL },
      evidenceDir,
      env: envVars,
      secrets,
      storageState: loadedStorageState ?? undefined,
      // `nuka do` has no scenario, so no chain: `ctx.resultOf` always
      // returns `undefined` here (docs/spec.md "Context API"; m2pre-
      // resultof task spec, decisions 1 and scope item 3). This matches
      // createStepContext's own default when `resultOf` is omitted — spelled
      // out explicitly here so this file's own contract with `ctx.resultOf`
      // is visible in the diff, not just inherited silently.
      resultOf: () => undefined,
      // Wired in even though `resultOf` above never returns a value under
      // `do` (m6a-from-core task spec, item 6): the unregistered-Step throw
      // is about `step` itself, not about whether a lookup would have
      // succeeded, so it must fire here exactly as it does under `nuka run`.
      isRegisteredStep,
      // `nuka do` is one execution, one trace chunk (p3a-trace-per-step task
      // spec, scope A item 4: "`nuka do` では step 名") — this ctx never
      // calls `beginStep`, so the step's own name, known once here, is the
      // only title its chunk (if `ctx.page()` is ever called) will use.
      stepTitle: name,
    });
    // `nuka do` is one execution, so `"scenario"` and `"process"` scope both
    // collapse to this one call's own lifetime (P5 task spec, scope item
    // 3; `.claude-team/playwright-native-design.md` 6 節): two separate,
    // freshly created caches (never shared across `nuka do` invocations),
    // each torn down once, below, after this step's own `run()` returns.
    const fixtureScenarioCache = createFixtureCache();
    const fixtureProcessCache = createFixtureCache();
    const startedAt = new Date();

    // `--use`'s actual effect (m6c-do-use task spec) — applied here, not in
    // setup, so `recordUsed` rides `contextHandle`'s own collector (it didn't
    // exist yet in setup); mirrors run-scenario.ts's own `injectFrom`, called
    // after that file's equivalent step-start timestamp for the same reason.
    // `--args` still wins for a key it already set (this task's spec, item
    // 5) — `parsedArgs` is only ever a plain object here for any key a
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
        // Only a receipt actually drawn from lands in `used` (docs/spec.md
        // "Single steps (the agent path)": "the receipt ids actually drawn
        // from land in this execution's own `used`") — one whose every
        // matching key was already overridden by `--args` contributed
        // nothing to this run, so it is not cited.
        if (filledAnyKey) {
          contextHandle.recordUsed(resolved.used.receipt, resolved.used.step, resolved.used.result);
        }
      }
    }

    let status: "ok" | "failed";
    let result: unknown;
    let errorMessage = "";
    // m3a-receipt-kinds task spec, decision 1: classified at each branch
    // that already knows *why* the step failed, not by inspecting the
    // message afterward. `nuka do` only ever runs a typed step (compat is
    // refused in setup, above) — a typed step's `run(fixtures, args)` never
    // receives `this` and has no timeout mechanism, so its own throw is
    // always `"step_error"` here, never `world_invalid`/`timeout` (those are
    // only reachable from a compat step's/hook's own execution, src/run/
    // run-scenario.ts).
    let errorKind: ErrorKind | undefined;
    // Every `config.fixtures` entry this step's own bag actually resolved
    // (P5 task spec, scope item 10) — `[]` (hence omitted on the receipt)
    // when args validation failed before fixture resolution ever ran.
    let fixtureUsage: FixtureUsageEntry[] = [];

    const argsResult = entry.step.args.safeParse(parsedArgs);
    if (!argsResult.success) {
      status = "failed";
      errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
      errorKind = "args_invalid";
    } else {
      try {
        // Bag construction happens inside this try, same as the `run()`
        // call itself below (p4a-fixture-bag task spec, widened by P5 to
        // also resolve `config.fixtures` entries): a step that names `page`
        // only launches the browser here, never earlier, and a launch
        // failure, a fixture setup failure, or a fixture use()-contract
        // violation are all a step failure ("step_error") this same way,
        // the same outcome a step's own `ctx.page()` throwing used to
        // produce when that call lived inside `run()`. `fixtureParameterNames`
        // is memoized and already validated in setup above, so it is not
        // expected to throw here.
        const resolved = await resolveFixtures({
          names: fixtureParameterNames(entry.step.run),
          graph: fixtureGraph,
          ctx: contextHandle.ctx,
          scenarioCache: fixtureScenarioCache,
          processCache: fixtureProcessCache,
          defaultTimeoutMs: config.fixtureTimeout,
        });
        fixtureUsage = resolved.usage;
        const fixtures = resolved.fixtures;
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
    // wrote over the wire anyway is no longer demoted for it here
    // (t2-trust-declaration task spec) — the declaration is trusted, and
    // `observed` below still records what actually happened, for a report
    // to catch a wrong declaration after the fact.
    const observed = contextHandle.observedCounts();
    // `ctx.section` works the same under `nuka do` as under `nuka run` (t3-
    // sections task spec, decision 6) — there is no scenario/pickle
    // concept here to special-case, so this is read the same way
    // `observed` is, right above.
    const sections = contextHandle.sectionsSnapshot();
    // Every `ctx.poll` call that finished during this execution, read the
    // same "after execution, whatever its outcome" way `sections` is right
    // above — a poll that timed out or whose `fn` threw still finished, in
    // the sense that matters here, and its own record is what a receipt for
    // a failed step needs most (ctx-poll-receipt task spec).
    const polls = contextHandle.pollsSnapshot();
    // Recorded even on a `MissingEnvError` failure (that throw happens
    // inside `entry.step.run`, above, well before this read) — same
    // "read the tally after execution, whatever its outcome" shape as
    // `observed`/`sections` (env-reads-and-mutates-doc task spec, item A).
    const requiredEnv = contextHandle.envReadsSnapshot();
    // Every receipt `--use` actually drew a value from, in the order given
    // (m6c-do-use task spec, item 6) — the same collector `ctx.resultOf`
    // itself would write into, read the same "after execution" way
    // `observed`/`sections`/`requiredEnv` are, right above. Under `do`,
    // `ctx.resultOf` never returns a value (`resultOf: () => undefined`
    // above), so `--use` is the only thing that can ever populate this here.
    const used = contextHandle.usedSnapshot();
    // Console errors/uncaught page errors/failed requests the browser
    // context saw during this execution, read the same "after execution,
    // whatever its outcome" way `observed`/`sections`/`polls`/`requiredEnv`
    // are (P0-page-events task spec) — `undefined` when `ctx.page()` was
    // never called, or was and the page stayed clean.
    const pageEvents = contextHandle.pageEventsSnapshot();
    // How many page-issued requests this execution made were left out of
    // http.jsonl, by resourceType, read the same "after execution, whatever
    // its outcome" way `pageEvents` just above is (p3b-page-network task
    // spec, scope item 2) — `undefined` when nothing was ever left out.
    const httpOmitted = contextHandle.httpOmittedSnapshot();

    const finishedAt = new Date();

    // Fixture teardown (P5 task spec, scope items 3, 6) — *before*
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
      // No status argument (fb4-evidence-time task spec, item 1) — see
      // create-context.ts's own `dispose` doc comment for why.
      disposeResult = await contextHandle.dispose();
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
    // `dispose()` above is what closes this execution's own (only) trace
    // chunk, if `ctx.page()` was ever called (create-context.ts's own
    // `closeCurrentChunk`) — trace.zip, when it exists at all, is fully
    // written by the time this runs, so `actions`/`truncated` can be read
    // out of it here (p3a-trace-per-step task spec, scope B).
    const traceEvidence = await collectTraceEvidence(evidenceDir, createTraceVersionWarner(stderr));

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
            scenario: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            evidence: { dir: relativeDir, ...evidence },
            observed,
            mutates: entry.step.mutates,
            // `omitUsedResults` (fb3-used-result task spec, decision 2): an
            // "ok" receipt keeps `used`'s original `{ receipt, step }` shape
            // — see the failed branch just below for the case that keeps
            // the upstream's own result.
            ...(used.length > 0 ? { used: omitUsedResults(used) } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(traceEvidence.truncated !== undefined ? { truncated: traceEvidence.truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
          }
        : {
            receipt_id: receiptId,
            step: name,
            kind: "do",
            args: parsedArgs,
            // `errorKind` is always set by this point: `status` only ever
            // becomes `"failed"` alongside it, at each branch above (this
            // task's spec, decision 1). The `?? "step_error"` fallback is a
            // belt-and-braces default, matching this task's own principle of
            // falling back to `step_error` whenever the classification is
            // ambiguous — it should never actually be reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment: resolvedEnv.name,
            target_version: targetVersion,
            session,
            scenario: null,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            mutates: entry.step.mutates,
            evidence: { dir: relativeDir, ...evidence },
            observed,
            // Unstripped here, unlike the "ok" branch above (fb3-used-result
            // task spec, decisions 1-2, 4): a failed step's receipt is
            // exactly where a reader most needs "what upstream value did
            // this `--use` draw on", without opening a second receipt.json.
            ...(used.length > 0 ? { used } : {}),
            ...(sections.length > 0 ? { sections } : {}),
            ...(polls.length > 0 ? { polls } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(traceEvidence.truncated !== undefined ? { truncated: traceEvidence.truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
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
    // execution failure, or success (this task's spec, decision 4: always
    // released when execution ends).
    if (lockPath !== null) {
      await releaseLock(lockPath);
    }
  }
}
