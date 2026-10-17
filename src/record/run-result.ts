import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDir } from "./run-exports.js";
import { SCHEMA_VERSIONS } from "./schema-version.js";

// Responsibility: run.json, the one machine-readable result a `nuka run`
// leaves in its `records/runs/<run_id>/`, and what `nuka run --json` prints.
// It names the run, its verdict, its counts, each scenario record with the
// command that reruns it, and the run summary, so an agent acts on a red run
// without parsing stderr or joining scenario records by `run_id`.
//
// It is also the run's completion marker. A scenario record says how one
// scenario went. It cannot say the run is over (a later scenario may still
// be waiting to write its own), and it cannot say a run-scope hook failed
// after every scenario passed. Only the invocation that ran everything
// knows both, so it writes this file last, and retention reads its presence
// as proof that the run ended. A run that was killed, or written before
// this file existed, has none. Retention treats that as "not proven
// finished", never as "failed".
//
// A rename makes the write atomic, so retention in another process never
// reads half a file as "no marker".

export const RUN_RESULT_FILE_NAME = "run.json";

export interface RunResultScenario {
  readonly scenario_record_id: string;
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
  readonly status: "passed" | "failed";
  /** The scenario record's file, relative to the project root. */
  readonly record: string;
  /** The command that runs this scenario alone, in the same environment. */
  readonly rerun: string;
}

export interface RunResult {
  readonly schema_version: typeof SCHEMA_VERSIONS.run_result;
  readonly nukadoko: string;
  readonly run_id: string;
  /** The exit verdict. It also counts a BeforeAll or AfterAll failure that
   * no scenario record carries, so it can be `failed` with every scenario
   * passed. */
  readonly verdict: "passed" | "failed";
  readonly started_at: string;
  readonly finished_at: string;
  readonly environment: string;
  readonly counts: { readonly scenarios: number; readonly passed: number; readonly failed: number };
  /** One entry per scenario record the run wrote, in the order written. */
  readonly scenarios: readonly RunResultScenario[];
  /** The run summary in the run directory, relative to the project root;
   * `null` when it could not be written. */
  readonly summary: string | null;
}

export interface RunResultInput {
  readonly nukadoko: string;
  readonly runId: string;
  readonly verdict: "passed" | "failed";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly environment: string;
  readonly scenarios: readonly RunResultScenario[];
  readonly summary: string | null;
}

export function buildRunResult(input: RunResultInput): RunResult {
  const passed = input.scenarios.filter((scenario) => scenario.status === "passed").length;
  return {
    schema_version: SCHEMA_VERSIONS.run_result,
    nukadoko: input.nukadoko,
    run_id: input.runId,
    verdict: input.verdict,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    environment: input.environment,
    counts: { scenarios: input.scenarios.length, passed, failed: input.scenarios.length - passed },
    scenarios: input.scenarios,
    summary: input.summary,
  };
}

export function runResultPath(rootDir: string, stateDir: string, runId: string): string {
  return path.join(runDir(rootDir, stateDir, runId), RUN_RESULT_FILE_NAME);
}

/** The run.json path relative to the project root, as stderr and the
 * summary name it. */
export function runResultRelativePath(stateDir: string, runId: string): string {
  return path.join(stateDir, "records", "runs", runId, RUN_RESULT_FILE_NAME);
}

export function writeRunResult(rootDir: string, stateDir: string, result: RunResult): void {
  const filePath = runResultPath(rootDir, stateDir, result.run_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, filePath);
}

/** Whether the run wrote a run.json that reads as one: an object with a
 * verdict. */
export function runEnded(rootDir: string, stateDir: string, runId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runResultPath(rootDir, stateDir, runId), "utf8"));
    if (parsed === null || typeof parsed !== "object") return false;
    const { verdict } = parsed as Record<string, unknown>;
    return verdict === "passed" || verdict === "failed";
  } catch {
    return false;
  }
}
