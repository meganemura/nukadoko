import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { loadConfig } from "../config/load-config.js";
import { createStepContext, type EvidenceResult } from "../context/create-context.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { generateReceiptId } from "../receipt/receipt-id.js";
import type { Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka do`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs (same split as vocabulary.ts).
// Two phases, matching docs/spec.md's "Running"/"Receipts" split exactly:
//
//   1. Setup — malformed --args JSON, an unknown step name, or a config/
//      discovery error. None of these write a receipt: the run never
//      started, so there is nothing to attest to (a receipt for an
//      execution that never began would let a nonexistent run be cited
//      later as if it had happened).
//   2. Execution — from here a receipt is always written, whatever
//      happens: args schema failure, the step's own throw, and returns
//      schema failure are all `status: "failed"` with `error.message`; only
//      a step whose args and returns both validate and whose `run` doesn't
//      throw is `status: "ok"`.
//
// The evidence-collecting side of ctx (browser/http/trace) is created and
// disposed here, never handed to the step itself — see
// context/create-context.ts's header for why that split exists.

export interface RunDoOptions {
  rootDir: string;
  name: string;
  argsJson: string;
  tag: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

function formatValidationIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${key}: ${issue.message}`;
    })
    .join("; ");
}

export async function runDo(options: RunDoOptions): Promise<number> {
  const { rootDir, name, argsJson, tag, stdout, stderr } = options;

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

  // --- Execution phase: a receipt is always written from here on. ---
  const receiptId = generateReceiptId();
  const relativeDir = path.join(config.stateDir, "receipts", receiptId);
  const evidenceDir = path.join(rootDir, relativeDir);
  await mkdir(evidenceDir, { recursive: true });

  const contextHandle = createStepContext({ rootDir, config, evidenceDir });
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
  let evidence: EvidenceResult;
  try {
    evidence = await contextHandle.dispose(status);
  } catch {
    // Last resort: browser-evidence.ts and create-context.ts's own dispose
    // already swallow their teardown failures, but this catch is the final
    // backstop so a failure neither of them anticipated still can't take
    // the receipt down with it (docs/spec.md "Receipts": a receipt is
    // written for every execution that started). No evidence file is known
    // to exist in that case, so none is listed.
    evidence = { screenshots: [] };
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
          environment: "default",
          session: null,
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
          environment: "default",
          session: null,
          tag,
          scenario: null,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          evidence: { dir: relativeDir, ...evidence },
        };

  await writeReceipt(evidenceDir, receipt);

  stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return status === "ok" ? 0 : 1;
}
