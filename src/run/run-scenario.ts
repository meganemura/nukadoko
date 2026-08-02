import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PickleStepType, type Pickle } from "@cucumber/messages";
import { formatValidationIssues } from "../binding/format-issues.js";
import type { NukadokoConfig } from "../config/schema.js";
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
import type { ScenarioRecord, ScenarioStepRecord } from "./record-types.js";
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
// step's own receipt (`used`).
//
// Object identity survives a step file importing another step file
// (m2pre-module-identity task spec): src/discover/discover-steps.ts loads
// every file through one shared tsx module registration for the whole
// discovery run, so a step file's own relative import of another step
// file's default export is the same object discovery put in this chain's
// key space. See tests/resultof.test.ts's header comment for the
// empirical proof this relies on.

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
  let scenarioFailed = false;

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
      // Temporary asymmetry (m2a-compat-registry task spec, item 7):
      // buildStepBindings only ever binds typed vocabulary entries in this
      // slice (see that file's own comment), so `entry` here can only ever
      // be the "typed" branch of the union `Vocabulary` now carries — this
      // is a type narrowing, not new run-time behavior. Compat step
      // execution is M2's slice B.
      if (entry.kind !== "typed") {
        continue;
      }

      // Read-only policy, declared-mutates refusal (this task's spec, decision
      // 3): a "never began" outcome, alongside undefined/ambiguous above — no
      // receipt id or directory is created, and the rest of the scenario is
      // skipped, matching cli/do.ts's own setup-phase refusal for the same
      // policy. `mutates: false` steps are unaffected regardless of policy; the
      // measured backstop for a *false* declaration lives further down, after
      // the step has actually run.
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

      // --- This step's execution has begun: a receipt is always written from
      // here, whatever happens (mirrors cli/do.ts's own execution phase). ---
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

      // Then-position measured enforcement (m2pre-observed task spec, decision
      // 4) and the read-only measured backstop (this task's spec, decision 3)
      // both only ever demote an otherwise-"ok" status — a step that already
      // failed for its own reason keeps that truthful failure and message
      // rather than being overwritten by either of these. Both key off the
      // same `observed.http_writes` and can therefore both apply to the same
      // occurrence at once; when they do, `errorMessage` says both rather than
      // picking one (this task's spec, decision 3).
      const observed = contextHandle.observedCounts();
      const usedReceiptIds = contextHandle.usedReceiptIds();
      const demotionMessages: string[] = [];
      if (status === "ok" && pickleStep.type === PickleStepType.OUTCOME && observed.http_writes > 0) {
        demotionMessages.push(thenObservedWritesMessage(outcome.stepName, observed.http_writes));
      }
      if (status === "ok" && policy === "read-only" && observed.http_writes > 0) {
        demotionMessages.push(
          readOnlyObservedWritesMessage(outcome.stepName, environment, observed.http_writes),
        );
      }
      if (demotionMessages.length > 0) {
        status = "failed";
        errorMessage = demotionMessages.join("; ");
      }

      // Only a step whose *final* status is "ok" ever becomes readable via
      // `ctx.resultOf` (this task's spec, decision 1) — a step demoted by
      // either check just above never enters the chain, matching "only a
      // validated result is citable" exactly.
      if (status === "ok") {
        chain.set(entry.step, { result, receiptId });
      }

      const stepFinishedAt = new Date();
      const httpLogExists = existsSync(path.join(receiptDir, "http.jsonl"));

      const receipt: Receipt =
        status === "ok"
          ? {
              receipt_id: receiptId,
              step: outcome.stepName,
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
                dir: relativeReceiptDir,
                screenshots: [],
                ...(httpLogExists ? { http: "http.jsonl" } : {}),
              },
              observed,
              ...(usedReceiptIds.length > 0 ? { used: usedReceiptIds } : {}),
            }
          : {
              receipt_id: receiptId,
              step: outcome.stepName,
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
                dir: relativeReceiptDir,
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
      await writeReceipt(receiptDir, redactedReceipt);

      if (status === "failed") {
        scenarioFailed = true;
      }
      stepRecords.push({
        text: pickleStep.text,
        status: status === "ok" ? "passed" : "failed",
        receipt: receiptId,
        ...(status === "failed" ? { error: { message: errorMessage } } : {}),
      });
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
