import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PickleStepType, type Pickle, type PickleStep } from "@cucumber/messages";
import { formatValidationIssues } from "../binding/format-issues.js";
import { DataTable } from "../compat/data-table.js";
import type { HookRegistration } from "../compat/hooks.js";
import { hookApplies } from "../compat/tag-expression.js";
import type { World } from "../compat/world.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import { createStepContext } from "../context/create-context.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { generateReceiptId } from "../receipt/receipt-id.js";
import type { Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { writeSessionFile } from "../session/store.js";
import type { StorageState } from "../session/storage-state.js";
import type { Step } from "../step/define-step.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "./match-step.js";
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
// slice's compat additions (m2-design.md section 6: "interop の データの橋は
// v1 では作らない").
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
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
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
   * item 4). Called exactly once per pickle. */
  readonly instantiateCompatWorld: (ctx: StepContext) => World;
  /** Every registered Before/After hook (src/discover/discover-steps.ts's
   * `DiscoveryResult.compatHooks`) — already validated for tag-expression
   * support by the caller (cli/run.ts's setup phase); this file only
   * filters by this pickle's own tags (this task's spec, item 5). */
  readonly compatHooks: readonly HookRegistration[];
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

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRecord> {
  const {
    rootDir,
    config,
    pickle,
    relativeFeaturePath,
    vocabulary,
    bindings,
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
    result: unknown,
    rawArgs: unknown,
    chainKey: Step | undefined,
  ): Promise<void> {
    let status = initialStatus;
    let errorMessage = initialErrorMessage;

    // Then-position measured enforcement (m2pre-observed task spec,
    // decision 4) and the read-only measured backstop (m2pre-resultof task
    // spec, decision 3) both only ever demote an otherwise-"ok" status — a
    // step that already failed for its own reason keeps that truthful
    // failure and message rather than being overwritten by either of
    // these. Both key off the same `observed.http_writes` and can
    // therefore both apply to the same occurrence at once; when they do,
    // `errorMessage` says both rather than picking one. Applied uniformly
    // regardless of kind (m2b-compat-execution task spec, item 6: "compat
    // step にも実行時の観測強制がそのまま適用される").
    const observed = contextHandle.observedCounts();
    const usedReceiptIds = contextHandle.usedReceiptIds();
    const demotionMessages: string[] = [];
    if (status === "ok" && pickleStep.type === PickleStepType.OUTCOME && observed.http_writes > 0) {
      demotionMessages.push(thenObservedWritesMessage(outcomeStepName, observed.http_writes));
    }
    if (status === "ok" && policy === "read-only" && observed.http_writes > 0) {
      demotionMessages.push(
        readOnlyObservedWritesMessage(outcomeStepName, environment, observed.http_writes),
      );
    }
    if (demotionMessages.length > 0) {
      status = "failed";
      errorMessage = demotionMessages.join("; ");
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
            ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
          }
        : {
            receipt_id: begun.receiptId,
            step: outcomeStepName,
            kind: "run",
            args: rawArgs,
            error: { message: errorMessage },
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
            ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
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
  // receives (item 4: "1 pickle = 1 World = 1 ctx").
  const world = instantiateCompatWorld(contextHandle.ctx);
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
  for (const hook of beforeHooks) {
    try {
      await hook.fn.call(world);
      hookRecords.push({ type: "before", status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hookRecords.push({ type: "before", status: "failed", error: { message } });
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
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
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
        const rawArgs: unknown = bindResult.ok ? bindResult.value : bindResult.partialValue;
        began.rawArgs = rawArgs;

        if (!bindResult.ok) {
          status = "failed";
          errorMessage = bindResult.message;
        } else {
          const argsResult = entry.step.args.safeParse(bindResult.value);
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
        }

        await finishExecutedStep(
          pickleStep,
          { receiptId, receiptDir, relativeReceiptDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          result,
          rawArgs,
          entry.step,
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
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
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
        try {
          await entry.compat.fn.apply(world, positionalArgs);
        } catch (error) {
          status = "failed";
          errorMessage = error instanceof Error ? error.message : String(error);
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
          null,
          rawArgsList,
          undefined,
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
        const receipt: Receipt = {
          receipt_id: began.receiptId,
          step: began.stepName,
          kind: "run",
          args: began.rawArgs,
          error: { message },
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
          ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
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
  for (const hook of afterHooks) {
    try {
      await hook.fn.call(world);
      hookRecords.push({ type: "after", status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hookRecords.push({ type: "after", status: "failed", error: { message } });
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
    evidence: {
      dir: relativeScenarioDir,
      screenshots: browserEvidence.screenshots,
      ...(browserEvidence.trace !== undefined ? { trace: browserEvidence.trace } : {}),
    },
  };

  const redactedRecord = redact(record, secrets) as ScenarioRecord;
  await writeScenarioRecord(scenarioDir, redactedRecord);
  return redactedRecord;
}
