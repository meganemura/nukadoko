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
  readonly targetVersion: string | undefined;
  readonly session: string | null;
  readonly tag: string | null;
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
    targetVersion,
    session,
    tag,
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

  const contextHandle = createStepContext({
    config,
    evidenceDir: scenarioDir,
    env,
    secrets,
    storageState: storageState ?? undefined,
  });

  const stepRecords: ScenarioStepRecord[] = [];
  let scenarioFailed = false;

  for (const pickleStep of pickle.steps) {
    if (scenarioFailed) {
      stepRecords.push({ text: pickleStep.text, status: "skipped", receipt: null });
      continue;
    }

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

    // --- This step's execution has begun: a receipt is always written from
    // here, whatever happens (mirrors cli/do.ts's own execution phase). ---
    const receiptId = generateReceiptId();
    const relativeReceiptDir = path.join(config.stateDir, "receipts", receiptId);
    const receiptDir = path.join(rootDir, relativeReceiptDir);
    await mkdir(receiptDir, { recursive: true });
    contextHandle.beginStep(receiptDir);

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

    // Then-position measured enforcement (this task's spec, decision 4):
    // only demotes an otherwise-"ok" status — a step that already failed
    // for its own reason keeps that truthful failure and message rather
    // than being overwritten by this one. Checked regardless of what the
    // step declared; `entry.step.mutates` plays no part here.
    const observed = contextHandle.observedCounts();
    if (status === "ok" && pickleStep.type === PickleStepType.OUTCOME && observed.http_writes > 0) {
      status = "failed";
      errorMessage = thenObservedWritesMessage(outcome.stepName, observed.http_writes);
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
            tag,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
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
            tag,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
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
    tag,
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
