import { formatValidationIssues } from "../issues/format-issues.js";
import { parseStepReturns } from "../step/parse-returns.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContextHandle } from "../context/create-context.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { resolveFixtures, type FixtureCache } from "../fixture/resolver.js";
import type { ErrorKind, FixtureUsageEntry } from "../record/types.js";
import type { Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";
import { classifyCaughtError, runWithTimeout } from "./run-scenario.js";

// Responsibility: one typed step, run once in a ctx the caller already
// holds. Validate the args, open the fixture bag, call `run` under the
// step's deadline, and validate what it returned. `nuka do` and
// `nuka experimental explore` both run a step through this function, so the
// two cannot disagree about what "the step passed" means. What happens
// around it (setup refusals, records, evidence, teardown) stays with each
// caller, because those differ.

export interface ExecuteTypedStepInput {
  readonly name: string;
  readonly step: Step;
  readonly args: unknown;
  readonly handle: StepContextHandle;
  readonly fixtureGraph: FixtureGraph;
  readonly scenarioCache: FixtureCache;
  readonly processCache: FixtureCache;
  readonly config: Pick<NukadokoConfig, "fixtureTimeout" | "stepTimeout">;
}

/** `args` is the validated value once validation passed, and the value
 * given otherwise, so a record never shows a key validation rejected or a
 * default it filled in silently. */
export type TypedStepOutcome =
  | {
      readonly status: "passed";
      readonly args: unknown;
      readonly result: unknown;
      readonly fixtureUsage: FixtureUsageEntry[];
    }
  | {
      readonly status: "failed";
      readonly args: unknown;
      readonly error: { readonly message: string; readonly kind: ErrorKind };
      readonly fixtureUsage: FixtureUsageEntry[];
    };

export async function executeTypedStep(input: ExecuteTypedStepInput): Promise<TypedStepOutcome> {
  const { name, step, handle, config } = input;
  const argsResult = strictArgsSchema(step.args).safeParse(input.args);
  if (!argsResult.success) {
    return {
      status: "failed",
      args: input.args,
      error: { message: `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`, kind: "args_invalid" },
      fixtureUsage: [],
    };
  }
  let fixtureUsage: FixtureUsageEntry[] = [];
  try {
    // Inside the try: a browser launch, a fixture setup, or a broken
    // use() contract fails the step the same way its own throw does.
    const resolved = await resolveFixtures({
      names: stepFixtureNames(step),
      graph: input.fixtureGraph,
      ctx: handle.ctx,
      scenarioCache: input.scenarioCache,
      processCache: input.processCache,
      defaultTimeoutMs: config.fixtureTimeout,
    });
    fixtureUsage = resolved.usage;
    handle.beginStepRun(step, resolved.fixtures);
    const runResult = await runWithTimeout(
      () => handle.recordingProcesses(() => Promise.resolve(step.run(resolved.fixtures, argsResult.data))),
      step.timeout ?? config.stepTimeout,
      "Step",
      name,
      step.timeout === undefined ? "config" : "step",
    );
    const returnsResult = parseStepReturns(step, runResult);
    if (!returnsResult.success) {
      return {
        status: "failed",
        args: argsResult.data,
        error: { message: returnsResult.message, kind: "result_invalid" },
        fixtureUsage,
      };
    }
    return { status: "passed", args: argsResult.data, result: returnsResult.data, fixtureUsage };
  } catch (error) {
    return {
      status: "failed",
      args: argsResult.data,
      error: { message: error instanceof Error ? error.message : String(error), kind: classifyCaughtError(error) },
      fixtureUsage,
    };
  }
}
