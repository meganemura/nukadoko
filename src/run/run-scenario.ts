import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  PickleStepType,
  type GherkinDocument,
  type Pickle,
  type PickleStep,
} from "@cucumber/messages";
import { formatValidationIssues } from "../binding/format-issues.js";
import { DataTable } from "../compat/data-table.js";
import {
  createDeclaredCollector,
  setActiveDeclaredCollector,
  type DeclaredCollector,
} from "../compat/declared.js";
import { CompatTimeoutError, isWorldWriteValidationError } from "../compat/errors.js";
import type { HookParameter, HookRegistration } from "../compat/hooks.js";
import { hookApplies } from "../compat/tag-expression.js";
import type { InstantiatedWorld } from "../compat/world.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import { createStepContext } from "../context/create-context.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { generateReceiptId } from "../receipt/receipt-id.js";
import type { ErrorKind, Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { writeSessionFile } from "../session/store.js";
import type { StorageState } from "../session/storage-state.js";
import type { Step } from "../step/define-step.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "./match-step.js";
import type { GitState } from "./probe-git.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "./record-types.js";
import { generateScenarioId } from "./scenario-id.js";
import { writeScenarioRecord } from "./write-record.js";

// Responsibility: execute one pickle end to end (this task's spec, item 1's
// "シナリオ実行器") — the scenario-level counterpart to cli/do.ts's execution
// phase. One `ctx` is created for the whole pickle and shared by every step
// (docs/spec.md "Running": "Steps in one pickle share one context"); a
// step's own failure/undefined/ambiguous/Then-position-observed-write stops
// matching or running any further step in this scenario, but every step
// still gets a scenario-record entry (`skipped` for the rest). Evidence
// follows its natural scope (this task's spec, decision 5): the browser's
// trace/screenshots belong to the scenario as a whole (one `dispose()` call,
// at the very end), while each step's own http.jsonl belongs to that step's
// receipt dir — reached by calling `contextHandle.beginStep` right before
// running each step that begins execution.
//
// The two "never began" outcomes (undefined, ambiguous) are resolved
// *before* a receipt id or directory is created — matching docs/spec.md "an
// execution that never began must not be citable". Every other failure
// (binding, args validation, the step's own throw, returns validation)
// happens *after* that point and therefore always gets a failed receipt,
// mirroring `nuka do`'s own setup/execution split (this task's spec,
// decision 4).
//
// A Then-position (`PickleStepType.OUTCOME`) step is no longer rejected
// ahead of execution for its *declared* `mutates` (m2pre-observed task
// spec, decisions 4-5, superseding this file's earlier static check): the
// same step text can legitimately appear in both Action and Outcome
// position, so only what a given occurrence's execution actually observed
// can settle it. The step always runs and always gets a receipt; if it is
// bound in Then position and its execution observed a network write, the
// receipt is demoted to `status: "failed"` afterward — measured, per
// occurrence, regardless of what `run` returned or what was declared.
//
// `policy: "read-only"` enforcement (m2pre-resultof task spec, decision 3)
// closes a gap this file always had: unlike cli/do.ts, `nuka run` never
// looked at the resolved environment's policy at all. It is two checks, one
// declared and one measured, exactly mirroring cli/do.ts's own split: a step
// whose *declared* `mutates` is `true` is refused before it ever runs — a
// "never began" outcome, alongside undefined/ambiguous, with `receipt: null`
// and the rest of the scenario skipped — while a step that declares
// `mutates: false` yet is *measured* observing a network write still gets a
// failed receipt afterward (the same lie backstop `nuka do` already has).
// The measured backstop can coincide with the Then-position measured check
// above (both key off the same `observed.http_writes`); when both apply to
// the same occurrence, `errorMessage` says both rather than picking one.
//
// `ctx.resultOf` (m2pre-resultof task spec, decisions 1-2): this file is the
// one place a pickle's result chain is held — a `Map` keyed by the Step
// object itself (not by name), updated only when a step's *final* status
// (after every demotion above) is `"ok"`. The chain is created fresh per
// scenario and never escapes this function, so it cannot leak between
// pickles; a step's own reader is wired into createStepContext's `resultOf`
// option as a plain closure over this map, and every value-returning read is
// reflected back afterward via `contextHandle.usedReceiptIds()` onto that
// step's own receipt (`used`). Only a *typed* step's chain key ever exists
// (compat has no Step object, and no validated result to offer — see below),
// so this chain is exclusively typed-to-typed provenance, unchanged by this
// slice's compat additions ("interop の データの橋は v1 では作らない").
//
// Object identity survives a step file importing another step file
// (m2pre-module-identity task spec): src/discover/discover-steps.ts loads
// every file through one shared tsx module registration for the whole
// discovery run, so a step file's own relative import of another step
// file's default export is the same object discovery put in this chain's
// key space. See tests/resultof.test.ts's header comment for the
// empirical proof this relies on.
//
// m2b-compat-execution task spec: this file now also runs compat steps and
// Before/After hooks, closing m2a-compat-registry's two temporary
// asymmetries (`buildStepBindings`/`matchPickleStep`, src/run/match-step.ts,
// already match through compat entries; this file is where a *matched*
// compat entry now actually executes instead of being skipped). One World
// is constructed per pickle (item 4: "1 pickle = 1 World = 1 ctx"), shared
// by every compat step and hook in it, wrapping the exact same `ctx` a typed
// step's `run(ctx, args)` receives — so a typed step's `ctx.request()` and a
// compat step's `this.request` (after `await this.openRequest()`) are the
// identical Playwright object, cookies and all. A compat step's own
// execution is much simpler than a typed step's: no args/returns schema,
// so no binding-failure branch and no `chain` entry ever gets written for
// one (`result: null` always, per docs/spec.md "Receipts": "Compat steps
// record result: null" — regardless of what the glue function itself
// returned). Before/After hooks run against that same World, outside any
// step's own receipt boundary — `contextHandle.beginStep(scenarioDir)`
// before each hook phase redirects http.jsonl logging and the `observed`
// tally away from any step's own receipt dir (this task's spec, item 5:
// "フック内のネットワークは step 境界外", a documented v1 limit rather than a
// bug: a hook's own network activity is neither measured on any step's
// receipt nor visible in the scenario record at all).
//
// m2d-allure-shim task spec: this file also owns `declaredCollector` (src/
// compat/declared.ts) — one per pickle, repointed as "the currently active
// declared collector" right after `instantiateCompatWorld` runs, and reset
// via its own `beginStep(dir)` at the same points `contextHandle.beginStep`/
// `worldInstrumentation.beginStep` already are: once per step (redirected to
// that step's own receipt dir) and once per *individual* Before/After hook
// invocation (redirected to `scenarioDir`, read right after that hook
// returns/throws) — kind-independent (a typed step's receipt gets this
// exactly like a compat step's does, since both the registered allure-js
// `TestRuntime` and a compat World's own attach/log/link read the same
// active pointer).
//
// m21b-compat-execution task spec: closes the "silent behavior change" gaps
// left in compat step/hook *execution* (as opposed to A's registration-time
// closures) — a compat step's or hook's own `{ timeout }` is now actually
// enforced (`runWithTimeout`, item 2), every Before/After hook is called
// with a real `HookParameter` instead of zero arguments (`buildHookParameter`,
// item 3), and a string return of `"pending"`/`"skipped"` or an apparent
// `done`-callback arity both fail loudly instead of silently passing (items
// 4-5) — all four checks apply only to compat steps and hooks, never to a
// typed step, whose fixed `run(ctx, args)` arity and zod-validated `returns`
// make none of cucumber-js's own conventions here relevant to it.
//
// m22-compat-run-scope task spec, item 1: `defaultTimeoutMs` (this run's own
// `setDefaultTimeout` value, or `undefined`) is threaded in from cli/run.ts
// and falls back only where a compat step's/hook's *own* `{ timeout }` is
// `undefined` (`?? defaultTimeoutMs` at each `runWithTimeout` call site
// below) — an own declaration always wins, matching cucumber-js. `undefined
// ?? undefined` stays `undefined`, so never calling `setDefaultTimeout`
// leaves every compat step/hook exactly as unbounded as before this task.
// `runWithTimeout`/`pendingOrSkippedMessage`/`doneCallbackMessage` are
// exported (unchanged otherwise) so cli/run.ts's own BeforeAll/AfterAll
// execution (this task's spec, item 2 — a run-scope hook, not a per-pickle
// one, so it does not belong in this file) reuses the exact same
// timeout-racing/message logic rather than a second, drifting copy of it.
//
// m4a-run-provenance task spec: `runId` and `git` are both computed once by
// the caller (cli/run.ts), before this run's own pickle loop, and threaded
// into every `runScenario` call unchanged — the same "measured once per
// run, not once per pickle" shape `targetVersion` above already has. This
// file only ever copies them onto each scenario record it writes.

/** The declared-mutates read-only refusal message (this task's spec,
 * decision 3): matches cli/do.ts's own setup-phase rejection wording, since
 * this is the same fact about the same policy, just reached from `nuka run`
 * this time. */
function readOnlyDeclaredMutatesMessage(stepName: string, environment: string): string {
  return `Step "${stepName}" mutates state but environment "${environment}" has policy "read-only"`;
}

/** The measured read-only backstop message (this task's spec, decision 3):
 * matches cli/do.ts's own execution-phase backstop wording — a declared
 * `mutates: false` that the execution's own observed writes contradict. */
function readOnlyObservedWritesMessage(
  stepName: string,
  environment: string,
  writes: number,
): string {
  return `Step "${stepName}" observed ${writes} network write${writes === 1 ? "" : "s"} but environment "${environment}" has policy "read-only"`;
}

/** One pickle's own result chain: which Step object most recently finished
 * with `status: "ok"`, and what its validated result plus receipt id were
 * (this task's spec, decision 1). */
interface ChainEntry {
  readonly result: unknown;
  readonly receiptId: string;
}

export interface RunScenarioOptions {
  readonly rootDir: string;
  /** Already resolved for this run's target environment (baseURL swapped in,
   * same as cli/do.ts passes to createStepContext) — see cli/run.ts. */
  readonly config: NukadokoConfig;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
  /** This pickle's own feature file, already parsed (src/feature/load-
   * features.ts's `parseFeatureSource`, m21b-compat-execution task spec,
   * item 3) — every Before/After hook's `HookParameter.gherkinDocument`
   * below is this exact object, never a partial/reconstructed stand-in
   * (this task's spec: "部分的なオブジェクトを渡してお茶を濁さないこと"). */
  readonly gherkinDocument: GherkinDocument;
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
  /** This `nuka run` invocation's own id (m4a-run-provenance task spec,
   * decision 1) — generated once by the caller (cli/run.ts), before any
   * pickle runs, and copied verbatim onto every scenario record this
   * invocation writes (`ScenarioRecord.run_id`). */
  readonly runId: string;
  /** The commit and cleanliness of the working tree when this run started
   * (m4a-run-provenance task spec, decisions 2 and 4) — probed once by the
   * caller (`src/run/probe-git.ts`), before any pickle runs, and copied
   * verbatim onto every scenario record this invocation writes
   * (`ScenarioRecord.git`). `undefined` outside a git repository or when
   * the probe itself failed; never causes this run to fail. */
  readonly git: GitState | undefined;
  readonly environment: string;
  /** The resolved environment's `policy` (cli/run.ts's `resolvedEnv.policy`)
   * — `"read-only"` refuses a declared-mutating step before it runs and
   * backstops a declared `mutates: false` step whose execution is measured
   * writing anyway (this task's spec, decision 3); `undefined` means no
   * restriction. */
  readonly policy: "read-only" | undefined;
  readonly targetVersion: string | undefined;
  readonly session: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: SecretSet;
  /** This scenario's starting storageState, already read from the session
   * file by the caller (this task's spec, decision 8: read at each
   * scenario's own start, so an earlier scenario's save in the same run is
   * visible to a later one) — `null` for no `--session` or a session's
   * first-ever use. */
  readonly storageState: StorageState | null;
  /** Where to persist this scenario's ending storageState, or `null` when
   * `--session` wasn't given (nothing is read or written). */
  readonly sessionFilePath: string | null;
  /** Constructs this pickle's own World (src/discover/discover-steps.ts's
   * `DiscoveryResult.instantiateCompatWorld`, m2b-compat-execution task spec,
   * item 4), already wrapped for measurement + this run's own `defineWorld`
   * schemas (m2c-typed-world task spec, items 1-2), with its `attach`/`log`/
   * `link` wired to the given declared collector (m2d-allure-shim task spec,
   * item 4). Called exactly once per pickle, with this function's own
   * freshly created `declaredCollector`. */
  readonly instantiateCompatWorld: (
    ctx: StepContext,
    declaredCollector: DeclaredCollector,
  ) => InstantiatedWorld;
  /** Every registered Before/After hook (src/discover/discover-steps.ts's
   * `DiscoveryResult.compatHooks`) — already validated for tag-expression
   * support by the caller (cli/run.ts's setup phase); this file only
   * filters by this pickle's own tags (this task's spec, item 5). */
  readonly compatHooks: readonly HookRegistration[];
  /** This run's own `setDefaultTimeout` value (src/discover/discover-
   * steps.ts's `DiscoveryResult.defaultTimeoutMs`), or `undefined` if it was
   * never called (m22-compat-run-scope task spec, item 1) — applied as the
   * fallback for a compat step's or Before/After hook's own `timeoutMs`
   * wherever that is `undefined`; an own declaration always wins. Not
   * applied to a typed step, which has no timeout mechanism at all. */
  readonly defaultTimeoutMs: number | undefined;
}

/** The Then-position + observed-write failure message (this task's spec,
 * decision 4): states the fact this receipt now records — writes were
 * measured, not merely declared, while bound in Then position. */
function thenObservedWritesMessage(stepName: string, writes: number): string {
  return `Step "${stepName}" is bound in Then position and observed ${writes} network write${writes === 1 ? "" : "s"}: Then must not mutate`;
}

function undefinedStepMessage(text: string): string {
  return `No step definition matches "${text}"; run \`nuka scaffold <name>\` to add one`;
}

function ambiguousStepMessage(text: string, stepNames: readonly string[]): string {
  return `"${text}" matches more than one step: ${[...stepNames].sort().join(", ")}`;
}

// --- m21b-compat-execution task spec, items 2, 4, 5: compat step/hook
// execution honesty (only compat entries and Before/After hooks — the audit
// this task closes is entirely about hand-written, cucumber-js-style glue;
// a typed step's `run(ctx, args)` has a fixed arity and a zod-validated
// return, so none of these three checks apply to one). ---

/** Item 2's failure message: names which timeout fired (a step's own
 * `{ timeout }` vs a hook's), on what, and the configured value. Not
 * exported — only `runWithTimeout` below builds one, and that function
 * itself is what cli/run.ts's own BeforeAll/AfterAll reuses (see this
 * file's own header, m22-compat-run-scope task spec addendum). */
function timeoutMessage(kind: "Step" | "Hook", name: string, timeoutMs: number): string {
  return `${kind} "${name}" timed out after ${timeoutMs}ms (its own registered timeout)`;
}

/** Item 4: cucumber-js interprets the string returns `"pending"`/`"skipped"`
 * as their own outcomes; nukadoko's receipt/record schema has no such status
 * (implementing it for real is explicitly out of this task's scope), so
 * rather than silently passing through as success, a step/hook that returns
 * one of these two strings is failed with a message a migrator can act on.
 * Exported (m22-compat-run-scope task spec addendum) so cli/run.ts's own
 * BeforeAll/AfterAll execution reports the exact same wording for the exact
 * same fact, rather than a second copy of this message. */
export function pendingOrSkippedMessage(kind: "Step" | "Hook", name: string, value: string): string {
  return (
    `${kind} "${name}" returned ${JSON.stringify(value)}, which nukadoko does not interpret ` +
    `as pending/skipped (unlike cucumber-js) — see docs/migration.md`
  );
}

/** Item 5: cucumber-js infers a `done` callback from a glue function
 * declaring one more parameter than it is actually called with, and passes
 * that extra argument a callback nukadoko never provides. Detected by arity
 * *before* calling the function at all — calling it would already be the
 * silent failure this closes (the callback never fires, the function
 * "succeeds" immediately having done none of its real work yet, and that
 * work keeps running unobserved after this step/hook is already recorded).
 * Exported for the same reason as `pendingOrSkippedMessage` above (m22-
 * compat-run-scope task spec addendum) — cli/run.ts's own BeforeAll/AfterAll
 * arity check reuses this exact wording. */
export function doneCallbackMessage(kind: "Step" | "Hook", name: string): string {
  return (
    `${kind} "${name}" appears to expect a done() callback (it declares more parameters ` +
    `than nukadoko passes it) — nukadoko has no callback form; rewrite it to return a ` +
    `Promise (async/await). See docs/migration.md`
  );
}

/**
 * Races `run()` against `timeoutMs` (when given) and returns whichever
 * settles first. Honest limit, spelled out here because it is easy to miss
 * (this task's spec, item 2): JavaScript cannot cancel an in-flight
 * Promise — a timed-out call's own body keeps executing to completion in
 * the background no matter what this function returns. All this actually
 * guarantees is that the step/hook that started it is recorded as failed
 * and `runScenario` moves on to whatever comes next; it does not stop the
 * timed-out work itself.
 *
 * `run()`'s own promise is given a no-op `.catch` up front regardless of
 * which side of the race wins: if it eventually rejects *after* losing to
 * the timeout, that rejection would otherwise be "unhandled" from Node's
 * point of view (Node terminates the whole process for an unhandled
 * rejection by default since Node 15) — precisely the kind of hard crash a
 * per-step timeout must never cause.
 *
 * The timer itself is always cleared, on every path, so a step/hook that
 * finishes in time never leaks a pending Node timer (this task's spec:
 * "タイマーは必ず解除する").
 *
 * Exported (m22-compat-run-scope task spec addendum) so cli/run.ts's own
 * BeforeAll/AfterAll execution races against the exact same logic a
 * scenario's own compat step/hook already does, rather than a second,
 * potentially-drifting copy of it — a run-scope hook is still "a compat
 * hook with a `{ timeout }`" as far as this function is concerned, it is
 * only *where* it runs (once per `nuka run`, not once per pickle) that
 * differs, and that difference lives entirely in the caller.
 */
export async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  kind: "Step" | "Hook",
  name: string,
): Promise<T> {
  if (timeoutMs === undefined) {
    return run();
  }
  const inFlight = run();
  inFlight.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CompatTimeoutError(timeoutMessage(kind, name, timeoutMs))),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([inFlight, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Classifies a compat step's/hook's own thrown value into the closed
 * `error.kind` enum (m3a-receipt-kinds task spec, decisions 1-2) —
 * identified by type, never by matching the thrown value's own message text
 * (this task's spec: "文字列マッチでメッセージを判定するのは不可"). Only
 * `CompatTimeoutError` (`runWithTimeout`, above, always constructed by this
 * very module) and a `WorldWriteValidationError` (a declared World key's
 * write, src/compat/world-instrumentation.ts — checked via
 * `isWorldWriteValidationError`'s own brand, not `instanceof`, since that
 * error is reached through discovery's own scoped tsx import and
 * `instanceof` would silently miss it there; see that function's own header)
 * are identifiable this way; anything else — including a non-`Error` thrown
 * value — falls back to `"step_error"` (this task's spec: "判定に迷ったら
 * step_error に倒す"). Not applied to a typed step's own throw: a typed
 * step never touches a World or `runWithTimeout` (no `this`, no timeout
 * mechanism — this file's own header), so that catch site hardcodes
 * `"step_error"` directly rather than call through here for a case that can
 * never actually occur. */
function classifyCaughtError(error: unknown): ErrorKind {
  if (error instanceof CompatTimeoutError) return "timeout";
  if (isWorldWriteValidationError(error)) return "world_invalid";
  return "step_error";
}

/** Builds this hook invocation's own `HookParameter` (this task's spec, item
 * 3) — `result` is included only for an After hook (`resultStatus !==
 * undefined`), matching cucumber-js's own convention of never setting it for
 * Before. */
function buildHookParameter(
  gherkinDocument: GherkinDocument,
  pickle: Pickle,
  testCaseStartedId: string,
  resultStatus: "PASSED" | "FAILED" | undefined,
): HookParameter {
  return {
    gherkinDocument,
    pickle,
    testCaseStartedId,
    willBeRetried: false,
    ...(resultStatus !== undefined ? { result: { status: resultStatus } } : {}),
  };
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRecord> {
  const {
    rootDir,
    config,
    pickle,
    relativeFeaturePath,
    gherkinDocument,
    vocabulary,
    bindings,
    runId,
    git,
    environment,
    policy,
    targetVersion,
    session,
    env,
    secrets,
    storageState,
    sessionFilePath,
    instantiateCompatWorld,
    compatHooks,
    defaultTimeoutMs,
  } = options;

  const scenarioId = generateScenarioId();
  const relativeScenarioDir = path.join(config.stateDir, "scenarios", scenarioId);
  const scenarioDir = path.join(rootDir, relativeScenarioDir);
  await mkdir(scenarioDir, { recursive: true });

  const startedAt = new Date();

  // This scenario's own result chain (this task's spec, decision 1) — kept
  // here, not inside create-context.ts, so it never outlives this one
  // pickle's execution. `readChain` is the plain closure createStepContext
  // wraps into `ctx.resultOf`; this function is the only place that ever
  // writes to `chain`.
  const chain = new Map<Step, ChainEntry>();
  function readChain(step: Step): ChainEntry | undefined {
    return chain.get(step);
  }

  const contextHandle = createStepContext({
    config,
    evidenceDir: scenarioDir,
    env,
    secrets,
    storageState: storageState ?? undefined,
    resultOf: readChain,
  });

  const stepRecords: ScenarioStepRecord[] = [];
  const hookRecords: ScenarioHookRecord[] = [];
  let scenarioFailed = false;

  /**
   * Shared by the typed and compat branches below (this task's spec, item
   * 2's asymmetry-closing and item 3's compat receipt shape): applies the
   * Then-position and read-only *measured* demotions (identical, regardless
   * of kind — both key off `observed.http_writes`, which every network path
   * this ctx opens tallies into whichever kind of step opened it), records
   * this step in `chain` when `chainKey` is given and the final status is
   * `"ok"` (typed only — `undefined` for a compat step, this task's spec,
   * item 4: "World は compat 同士"), then builds, redacts, and writes the
   * receipt and this step's own scenario-record entry. A closure over this
   * function's own `chain`/`contextHandle`/`environment`/`policy`/
   * `targetVersion`/`session`/`scenarioId`/`secrets`, and mutates the outer
   * `scenarioFailed`/`stepRecords` — kept as a nested function rather than
   * a free one specifically so it can reach all of that without threading
   * every one of those through its own parameter list.
   */
  async function finishExecutedStep(
    pickleStep: PickleStep,
    begun: { readonly receiptId: string; readonly receiptDir: string; readonly relativeReceiptDir: string },
    stepStartedAt: Date,
    outcomeStepName: string,
    initialStatus: "ok" | "failed",
    initialErrorMessage: string,
    // `undefined` exactly when `initialStatus` is `"ok"` — a real `ErrorKind`
    // is required whenever the caller already knows this step failed for its
    // own reason (args/binding/returns/its own throw), m3a-receipt-kinds
    // task spec, decision 1.
    initialErrorKind: ErrorKind | undefined,
    result: unknown,
    rawArgs: unknown,
    chainKey: Step | undefined,
    // This step's own declared `mutates` (typed) or `null` (compat, which
    // has no declaration at all) — this task's spec, decision 3.
    mutates: boolean | null,
  ): Promise<void> {
    let status = initialStatus;
    let errorMessage = initialErrorMessage;
    let errorKind = initialErrorKind;

    // Then-position measured enforcement (m2pre-observed task spec,
    // decision 4) and the read-only measured backstop (m2pre-resultof task
    // spec, decision 3) both only ever demote an otherwise-"ok" status — a
    // step that already failed for its own reason keeps that truthful
    // failure and message rather than being overwritten by either of
    // these. Both key off the same `observed.http_writes` and can
    // therefore both apply to the same occurrence at once; when they do,
    // `errorMessage` says both rather than picking one, and `errorKind`
    // takes `then_mutated`. A closed enum can only carry one value, and
    // that is the one worth carrying: a mutating step bound in Then
    // position is a defect in the vocabulary itself, true in every
    // environment and fixable once, whereas a read-only violation
    // describes where this particular run happened to point. The
    // structural fault is the more actionable category for a report to
    // file the failure under. Applied uniformly
    // regardless of kind (m2b-compat-execution task spec, item 6: "compat
    // step にも実行時の観測強制がそのまま適用される").
    const observed = contextHandle.observedCounts();
    const usedReceiptIds = contextHandle.usedReceiptIds();
    // World reads/writes tallied since the current step boundary began (m2c-
    // typed-world task spec, item 3) — always empty for a typed step (no
    // `this`), so the `world` field below is naturally omitted for one,
    // with no separate kind check needed.
    const worldReadsWrites = worldInstrumentation.snapshot();
    // What this step (kind-independent) declared through the allure-js
    // runtime shim or a compat World's own attach/log/link (m2d-allure-shim
    // task spec, items 2-3) — `undefined` when nothing was ever recorded
    // this step, omitted from the receipt the same way `used`/`world` are.
    const declared = declaredCollector.snapshot();
    const demotionMessages: string[] = [];
    let demotionKind: ErrorKind | undefined;
    if (status === "ok" && pickleStep.type === PickleStepType.OUTCOME && observed.http_writes > 0) {
      demotionMessages.push(thenObservedWritesMessage(outcomeStepName, observed.http_writes));
      demotionKind ??= "then_mutated";
    }
    if (status === "ok" && policy === "read-only" && observed.http_writes > 0) {
      demotionMessages.push(
        readOnlyObservedWritesMessage(outcomeStepName, environment, observed.http_writes),
      );
      demotionKind ??= "read_only_violation";
    }
    if (demotionMessages.length > 0) {
      status = "failed";
      errorMessage = demotionMessages.join("; ");
      errorKind = demotionKind;
    }

    // Only a step whose *final* status is "ok" ever becomes readable via
    // `ctx.resultOf`, and only when `chainKey` is given at all (typed only).
    if (status === "ok" && chainKey !== undefined) {
      chain.set(chainKey, { result, receiptId: begun.receiptId });
    }

    const stepFinishedAt = new Date();
    const httpLogExists = existsSync(path.join(begun.receiptDir, "http.jsonl"));

    const receipt: Receipt =
      status === "ok"
        ? {
            receipt_id: begun.receiptId,
            step: outcomeStepName,
            kind: "run",
            args: rawArgs,
            result,
            status: "ok",
            environment,
            target_version: targetVersion,
            session,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
            mutates,
            ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
          }
        : {
            receipt_id: begun.receiptId,
            step: outcomeStepName,
            kind: "run",
            args: rawArgs,
            // `errorKind` is guaranteed set by this point: either the
            // caller passed one in (status already "failed" on entry) or a
            // demotion above just set both `status` and `errorKind`
            // together. The `?? "step_error"` fallback is a belt-and-
            // braces default only, matching this task's own "判定に迷った
            // ら step_error に倒す" principle — it should never actually be
            // reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment,
            target_version: targetVersion,
            session,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
            mutates,
            ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
          };

    // Redacted once, as one object, same as `nuka do` (this task's spec,
    // decision 6): receipt.json must never be able to disagree with the
    // scenario record about what got redacted.
    const redactedReceipt = redact(receipt, secrets) as Receipt;
    await writeReceipt(begun.receiptDir, redactedReceipt);

    if (status === "failed") {
      scenarioFailed = true;
    }
    stepRecords.push({
      text: pickleStep.text,
      status: status === "ok" ? "passed" : "failed",
      receipt: begun.receiptId,
      ...(status === "failed" ? { error: { message: errorMessage } } : {}),
    });
  }

  // --- Hooks + World (m2b-compat-execution task spec, items 4-5) ---
  // One World per pickle, shared by every compat step and hook that runs in
  // it, wrapping this same `contextHandle.ctx` a typed step's `run` also
  // receives (item 4: "1 pickle = 1 World = 1 ctx"). `worldInstrumentation`
  // is this same World's own measurement handle (m2c-typed-world task spec,
  // items 1-3) — advanced (`beginStep()`) at the exact same points
  // `contextHandle.beginStep()` is called below, and read (`snapshot()`)
  // inside `finishExecutedStep` and this function's own backstop catch.
  // m2d-allure-shim task spec, items 1-2: one collector for this whole
  // pickle. Repointed as "the currently active declared collector" (read by
  // the registered allure-js `TestRuntime`, src/compat/allure-runtime.ts) and
  // passed directly into `instantiateCompatWorld` so this pickle's own
  // `world.attach`/`log`/`link` write into the exact same instance (src/
  // compat/world.ts's own header explains why the World channel gets the
  // object passed directly rather than reading it back through the active
  // pointer) — a facade call and a World-channel call in the same step/hook
  // land in the same place either way. Its own `beginStep`/`snapshot` are
  // called at each step/hook boundary below, independently of
  // `contextHandle`/`worldInstrumentation`'s own boundary calls.
  const declaredCollector = createDeclaredCollector();
  setActiveDeclaredCollector(declaredCollector);
  const { world, instrumentation: worldInstrumentation } = instantiateCompatWorld(
    contextHandle.ctx,
    declaredCollector,
  );
  const pickleTags = pickle.tags.map((tag) => tag.name);
  const beforeHooks = compatHooks.filter(
    (hook) => hook.type === "before" && hookApplies(hook.tags, pickleTags),
  );
  // After hooks run in reverse registration order — cucumber-js's own
  // convention: teardown unwinds in the opposite order setup ran in.
  const afterHooks = compatHooks
    .filter((hook) => hook.type === "after" && hookApplies(hook.tags, pickleTags))
    .slice()
    .reverse();

  // Hooks get their own boundary, never a step's own receipt dir (this
  // task's spec, item 5: "フック内のネットワークは step 境界外") — redirected
  // to the scenario dir itself, the same place `httpLogDir` already starts
  // out pointed at before any step's own `beginStep()` call ever runs.
  contextHandle.beginStep(scenarioDir);
  // Same step-boundary point for the World's own instrumentation (m2c-typed-
  // world task spec, item 1's reconcile + item 3's per-boundary reset) — a
  // Before hook's own World reads/writes get tallied here but are discarded
  // by the very next `beginStep()` call (before step 1), so they are never
  // attributed to any step's receipt, the same isolation `observed`/`used`
  // already give hooks.
  worldInstrumentation.beginStep();
  for (const hook of beforeHooks) {
    // m2d-allure-shim task spec, item 4: each hook gets its own declared
    // boundary — reset right before it runs, read right after — so one
    // hook's own facade/World-channel calls land on exactly that hook's own
    // `hookRecords` entry, never smeared across its sibling Before hooks.
    // Independent of `contextHandle`/`worldInstrumentation`'s own
    // once-per-phase boundary above (observed/world stay a documented v1
    // limit for hooks, unchanged by this task — see this file's own
    // header).
    declaredCollector.beginStep(scenarioDir);
    // Item 3: `HookParameter.result` is absent for a Before hook (cucumber-js
    // never sets it there either — a scenario's outcome isn't known yet).
    const hookParameter = buildHookParameter(gherkinDocument, pickle, scenarioId, undefined);
    // m3a-receipt-kinds task spec, decision 2: the arity check and the
    // pending/skipped return are both classified `"unsupported"` directly,
    // at the exact point each is detected — set on `hookStatus`/
    // `hookErrorKind` rather than thrown, so they never need to be told
    // apart from a hook's own throw (`timeout`/`world_invalid`/`step_error`,
    // via `classifyCaughtError`) inside a shared catch block afterward. This
    // mirrors the compat step branch's own arity/pending-skipped checks
    // further down in this file, which already work the same non-throwing
    // way.
    let hookStatus: "ok" | "failed" = "ok";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    if (hook.fn.length >= 2) {
      // Item 5's arity check, before the call itself (see runWithTimeout's
      // own header for why calling it at all would already be the failure).
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", "Before");
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          "Before",
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", "Before", returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
      }
    }
    const declared = declaredCollector.snapshot();
    if (hookStatus === "ok") {
      hookRecords.push({ type: "before", status: "ok", ...(declared ? { declared } : {}) });
    } else {
      hookRecords.push({
        type: "before",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
      // Stop at the first Before failure (this task's spec, item 5: "Before
      // 失敗 = 全 step skip"): this scenario's setup already didn't
      // complete, so there is nothing left for a later Before hook to
      // prepare into.
      break;
    }
  }

  for (const pickleStep of pickle.steps) {
    if (scenarioFailed) {
      stepRecords.push({ text: pickleStep.text, status: "skipped", receipt: null });
      continue;
    }

    // General per-step backstop (fix-scenario-step-backstop task spec,
    // decisions 1-2): everything from matching this step's text through
    // writing its receipt sits inside the try below, so ANY unexpected
    // throw still leaves this pickle's own scenario record written
    // (docs/spec.md "Running": once a pickle begins executing, every step
    // gets a record entry) instead of crashing the whole `nuka run`
    // invocation uncaught. The violation this backstop exists for: a
    // custom `config.parameterTypes` transformer's throw propagates
    // unchanged straight out of match-step.ts's `matchPickleStep` (that
    // file's own header comment, decision 5 — cucumber-expressions itself
    // never catches a transformer call, and that module deliberately
    // doesn't either), and nothing between it and here caught it before
    // this task. This backstop changes nothing about any failure already
    // handled by name below (undefined/ambiguous/binding failure/args
    // zod/the step's own `run` throw/Then-position writes/read-only) —
    // each keeps its own branch, unchanged; this is only the last net
    // underneath all of them. `began` mirrors the exact point (marked
    // below, unchanged from before this task) this function already
    // treats as "a receipt is always written from here on": a throw
    // before it is "never began" (`receipt: null`, the same family as
    // undefined/ambiguous/the read-only declared-mutates refusal just
    // below), while a throw at or after it still gets a receipt written,
    // exactly like any other execution-phase failure this function
    // already handles inline.
    let began: {
      readonly receiptId: string;
      readonly receiptDir: string;
      readonly relativeReceiptDir: string;
      readonly stepName: string;
      readonly startedAt: Date;
      // This step's own declared `mutates` (typed) or `null` (compat) —
      // carried on `began` so the general backstop catch below (which has
      // no `entry` in scope of its own) can still put the right value on a
      // receipt it has to write (this task's spec, decision 3).
      readonly mutates: boolean | null;
      rawArgs: unknown;
    } | null = null;

    try {
      const outcome = matchPickleStep(pickleStep.text, bindings);

      if (outcome.kind === "undefined") {
        scenarioFailed = true;
        stepRecords.push({
          text: pickleStep.text,
          status: "undefined",
          receipt: null,
          error: { message: undefinedStepMessage(pickleStep.text) },
        });
        continue;
      }

      if (outcome.kind === "ambiguous") {
        scenarioFailed = true;
        stepRecords.push({
          text: pickleStep.text,
          status: "ambiguous",
          receipt: null,
          error: { message: ambiguousStepMessage(pickleStep.text, outcome.stepNames) },
        });
        continue;
      }

      const entry = vocabulary.get(outcome.stepName);
      if (!entry) {
        // Unreachable: `outcome.stepName` only ever comes from a binding built
        // from this same vocabulary (match-step.ts's buildStepBindings).
        continue;
      }

      if (entry.kind === "typed") {
        // Read-only policy, declared-mutates refusal (this task's spec,
        // decision 3): a "never began" outcome, alongside undefined/
        // ambiguous above — no receipt id or directory is created, and the
        // rest of the scenario is skipped, matching cli/do.ts's own
        // setup-phase refusal for the same policy. `mutates: false` steps
        // are unaffected regardless of policy; the measured backstop for a
        // *false* declaration lives inside `finishExecutedStep`, after the
        // step has actually run. A compat entry has no declared `mutates`
        // at all (m2b-compat-execution task spec, item 2), so this check
        // simply does not apply to one — only the measured backstop below
        // ever catches a compat step's read-only violation.
        if (policy === "read-only" && entry.step.mutates) {
          scenarioFailed = true;
          stepRecords.push({
            text: pickleStep.text,
            status: "failed",
            receipt: null,
            error: { message: readOnlyDeclaredMutatesMessage(outcome.stepName, environment) },
          });
          continue;
        }

        // --- This step's execution has begun: a receipt is always written
        // from here, whatever happens (mirrors cli/do.ts's own execution
        // phase). ---
        const receiptId = generateReceiptId();
        const relativeReceiptDir = path.join(config.stateDir, "receipts", receiptId);
        const receiptDir = path.join(rootDir, relativeReceiptDir);
        await mkdir(receiptDir, { recursive: true });
        contextHandle.beginStep(receiptDir);
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(receiptDir);
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          mutates: entry.step.mutates,
          rawArgs: undefined,
        };

        const bindResult = bindStepArgs(
          outcome.stepName,
          outcome.captures,
          outcome.values,
          pickleStep.argument,
          entry.step.args,
        );

        const stepStartedAt = new Date();
        let status: "ok" | "failed";
        let result: unknown;
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        const rawArgs: unknown = bindResult.ok ? bindResult.value : bindResult.partialValue;
        began.rawArgs = rawArgs;

        if (!bindResult.ok) {
          status = "failed";
          errorMessage = bindResult.message;
          errorKind = "binding_invalid";
        } else {
          const argsResult = entry.step.args.safeParse(bindResult.value);
          if (!argsResult.success) {
            status = "failed";
            errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
            errorKind = "args_invalid";
          } else {
            try {
              const runResult = await entry.step.run(contextHandle.ctx, argsResult.data);
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
              // Always "step_error", never routed through
              // `classifyCaughtError` (this file's own header, m3a-receipt-
              // kinds task spec): a typed step's `run(ctx, args)` never
              // receives `this` and has no timeout mechanism, so neither a
              // `WorldWriteValidationError` nor a `CompatTimeoutError` can
              // ever reach this catch.
              status = "failed";
              errorMessage = error instanceof Error ? error.message : String(error);
              errorKind = "step_error";
            }
          }
        }

        await finishExecutedStep(
          pickleStep,
          { receiptId, receiptDir, relativeReceiptDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          result,
          rawArgs,
          entry.step,
          entry.step.mutates,
        );
      } else {
        // entry.kind === "compat" (m2b-compat-execution task spec, items
        // 2-3): fn is called with `this = World` and positional arguments —
        // no args/returns schema exists to validate against, so there is no
        // binding-failure branch here the way there is for a typed step.
        const receiptId = generateReceiptId();
        const relativeReceiptDir = path.join(config.stateDir, "receipts", receiptId);
        const receiptDir = path.join(rootDir, relativeReceiptDir);
        await mkdir(receiptDir, { recursive: true });
        contextHandle.beginStep(receiptDir);
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(receiptDir);
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          // Compat has no `mutates` declaration at all (this task's spec,
          // decision 3) — `null`, never coerced to `false`.
          mutates: null,
          rawArgs: undefined,
        };

        // Positional args: the matched values, then — when the pickle step
        // carries a table or docstring — one more argument (this task's
        // spec, item 3). The receipt's own `args` stays JSON-plain
        // (`string[][]`/`string`); the *function call* gets a richer
        // `DataTable` wrapping those same rows (2026-08-02 lead scope
        // addendum: a raw `string[][]` would break existing glue calling
        // `table.hashes()`/`.rowsHash()`, which the migration-door rule
        // forbids) — two shapes for two different consumers of the exact
        // same data; the DataTable object itself is never what gets
        // serialized.
        const positionalArgs: unknown[] = [...outcome.values];
        const rawArgsList: unknown[] = [...outcome.values];
        if (pickleStep.argument?.dataTable !== undefined) {
          const rows = pickleStep.argument.dataTable.rows.map((row) =>
            row.cells.map((cell) => cell.value),
          );
          positionalArgs.push(new DataTable(rows));
          rawArgsList.push(rows);
        } else if (pickleStep.argument?.docString !== undefined) {
          positionalArgs.push(pickleStep.argument.docString.content);
          rawArgsList.push(pickleStep.argument.docString.content);
        }
        began.rawArgs = rawArgsList;

        const stepStartedAt = new Date();
        let status: "ok" | "failed" = "ok";
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        // Item 5's arity check, before the call itself: a compat step's
        // glue function declaring more parameters than `positionalArgs`
        // actually supplies is cucumber-js's own signal for a `done`
        // callback — nukadoko never passes one (see `doneCallbackMessage`'s
        // own header for why calling it anyway would already be the
        // failure this closes).
        if (entry.compat.fn.length > positionalArgs.length) {
          status = "failed";
          errorMessage = doneCallbackMessage("Step", outcome.stepName);
          errorKind = "unsupported";
        } else {
          try {
            // Item 2: `entry.compat.timeoutMs` is this step's own
            // `{ timeout }` (wired through discover-steps.ts's
            // `CompatStepDefinition.timeoutMs`) — `undefined` runs
            // unbounded, same as before this task. m22-compat-run-scope task
            // spec, item 1: `?? defaultTimeoutMs` only ever takes effect when
            // this step declared no `{ timeout }` of its own.
            const returnValue = await runWithTimeout(
              () => Promise.resolve(entry.compat.fn.apply(world, positionalArgs)),
              entry.compat.timeoutMs ?? defaultTimeoutMs,
              "Step",
              outcome.stepName,
            );
            // Item 4: cucumber-js's own pending/skipped return convention —
            // nukadoko doesn't implement either, so this fails loudly
            // instead of quietly passing (see `pendingOrSkippedMessage`'s
            // own header).
            if (returnValue === "pending" || returnValue === "skipped") {
              status = "failed";
              errorMessage = pendingOrSkippedMessage("Step", outcome.stepName, returnValue);
              errorKind = "unsupported";
            }
          } catch (error) {
            // m3a-receipt-kinds task spec, decisions 1-2: identified by
            // type (`CompatTimeoutError`/`WorldWriteValidationError`), never
            // by matching `message` — see `classifyCaughtError`'s own header.
            status = "failed";
            errorMessage = error instanceof Error ? error.message : String(error);
            errorKind = classifyCaughtError(error);
          }
        }

        // `result: null` unconditionally on a non-throwing run (docs/
        // spec.md "Receipts": "Compat steps record result: null") — never
        // whatever `fn` itself happened to return, and no `chain` entry
        // (compat has no validated result to make citable via
        // `ctx.resultOf`, and no Step object to key one on).
        await finishExecutedStep(
          pickleStep,
          { receiptId, receiptDir, relativeReceiptDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          null,
          rawArgsList,
          undefined,
          null,
        );
      }
    } catch (error) {
      // The backstop itself (see the comment above `began`): anything that
      // threw without ever being turned into a `status`/`errorMessage` pair
      // above lands here. `began` says whether this step's own receipt phase
      // had started by then, so the same "never began" vs "always gets a
      // receipt" boundary this function already draws elsewhere still holds.
      scenarioFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      if (began === null) {
        stepRecords.push({
          text: pickleStep.text,
          status: "failed",
          receipt: null,
          error: { message },
        });
      } else {
        const stepFinishedAt = new Date();
        const httpLogExists = existsSync(path.join(began.receiptDir, "http.jsonl"));
        const observed = contextHandle.observedCounts();
        const usedReceiptIds = contextHandle.usedReceiptIds();
        const worldReadsWrites = worldInstrumentation.snapshot();
        const declared = declaredCollector.snapshot();
        const receipt: Receipt = {
          receipt_id: began.receiptId,
          step: began.stepName,
          kind: "run",
          args: began.rawArgs,
          // This is the true catch-all: whatever threw here was never
          // turned into an `ErrorKind` by any of the classification points
          // above, so this is the "判定に迷ったら step_error に倒す" case
          // itself, not just its fallback (this task's spec, decision 1).
          error: { message, kind: "step_error" },
          status: "failed",
          environment,
          target_version: targetVersion,
          session,
          scenario: scenarioId,
          started_at: began.startedAt.toISOString(),
          finished_at: stepFinishedAt.toISOString(),
          evidence: {
            dir: began.relativeReceiptDir,
            screenshots: [],
            ...(httpLogExists ? { http: "http.jsonl" } : {}),
          },
          observed,
          mutates: began.mutates,
          ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
          ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
            ? { world: worldReadsWrites }
            : {}),
          ...(declared ? { declared } : {}),
        };
        const redactedReceipt = redact(receipt, secrets) as Receipt;
        await writeReceipt(began.receiptDir, redactedReceipt);
        stepRecords.push({
          text: pickleStep.text,
          status: "failed",
          receipt: began.receiptId,
          error: { message },
        });
      }
    }
  }

  // After hooks are attempted regardless of Before/step outcome (this
  // task's spec, item 5), before dispose() so a hook can still use
  // `this.page`/`this.request` while the browser/request context is open —
  // redirected to the scenario's own boundary for the same reason Before
  // hooks are, above, rather than left pointed at whichever step happened
  // to run last.
  contextHandle.beginStep(scenarioDir);
  worldInstrumentation.beginStep();
  for (const hook of afterHooks) {
    // Same per-hook declared boundary as the Before loop above (this task's
    // spec, item 4) — reset right before, read right after, so one After
    // hook's own declared data never bleeds into a sibling's.
    declaredCollector.beginStep(scenarioDir);
    // Item 3: `result.status` reflects the scenario's outcome *as of right
    // before this After hook runs* — every Before hook and every step has
    // already had its chance to set `scenarioFailed`, and an earlier After
    // hook in this same loop (if any) already folded its own failure in too
    // (cucumber-js's own convention: each After hook sees the running
    // outcome, not only the pre-teardown one).
    const hookParameter = buildHookParameter(
      gherkinDocument,
      pickle,
      scenarioId,
      scenarioFailed ? "FAILED" : "PASSED",
    );
    // Same non-throwing arity/pending-skipped classification as the Before
    // loop above (this task's spec, decision 2) — see that loop's own
    // comment for why.
    let hookStatus: "ok" | "failed" = "ok";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    if (hook.fn.length >= 2) {
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", "After");
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          "After",
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", "After", returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
      }
    }
    const declared = declaredCollector.snapshot();
    if (hookStatus === "ok") {
      hookRecords.push({ type: "after", status: "ok", ...(declared ? { declared } : {}) });
    } else {
      hookRecords.push({
        type: "after",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
    }
  }

  const finishedAt = new Date();
  const scenarioStatusForEvidence: "ok" | "failed" = scenarioFailed ? "failed" : "ok";

  let disposeResult;
  try {
    disposeResult = await contextHandle.dispose(scenarioStatusForEvidence);
  } catch {
    // Same backstop as cli/do.ts: teardown failures must never take the
    // scenario record down with them.
    disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
  }
  const { evidence: browserEvidence, storageState: storageStateToPersist } = disposeResult;

  if (sessionFilePath !== null && storageStateToPersist !== undefined) {
    try {
      await writeSessionFile(sessionFilePath, storageStateToPersist);
    } catch {
      // Persisting the session must not cost the scenario record, mirroring
      // cli/do.ts's own fault tolerance.
    }
  }

  const record: ScenarioRecord = {
    scenario_id: scenarioId,
    run_id: runId,
    feature: relativeFeaturePath,
    scenario: pickle.name,
    line: pickle.location?.line ?? 0,
    status: scenarioFailed ? "failed" : "passed",
    environment,
    ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
    session,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    steps: stepRecords,
    hooks: hookRecords,
    ...(git !== undefined ? { git } : {}),
    evidence: {
      dir: relativeScenarioDir,
      screenshots: browserEvidence.screenshots,
      ...(browserEvidence.trace !== undefined ? { trace: browserEvidence.trace } : {}),
    },
  };

  const redactedRecord = redact(record, secrets) as ScenarioRecord;
  await writeScenarioRecord(scenarioDir, redactedRecord);
  // This pickle is done — repoint "the currently active declared collector"
  // to nothing, so a stray facade call between this pickle and the next
  // (there shouldn't be one, but this mirrors `used`/`observed`'s own "never
  // let a boundary bleed into unrelated code" discipline) can't silently
  // land on an already-read collector instead of being dropped.
  setActiveDeclaredCollector(undefined);
  return redactedRecord;
}
