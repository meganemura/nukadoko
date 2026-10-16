import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { NukadokoConfig } from "../config/schema.js";
import { createStepContext } from "../context/create-context.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { ReadOnlyEnvironmentError } from "../environment/resolve-environment.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { createFixtureCache, teardownFixtureCache } from "../fixture/resolver.js";
import { executeTypedStep } from "../run/execute-typed-step.js";
import { runOnce, type ProcessSignal } from "../run/process-signal.js";
import { fixtureTeardownWarning, redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import type { Step } from "../step/define-step.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import { registeredStepPredicate } from "../step/validate-from.js";
import type { OpenSequence, SequenceSession, StepOutcome } from "./sequence.js";

// Responsibility: the world generated sequences run in. Each `open` builds
// a fresh ctx and a fresh scenario-scope fixture cache, and the session's
// `close` tears both down, so a scenario-scope fixture that resets the
// target runs before every sequence. The process-scope cache is shared by
// every sequence of the invocation, runs and shrink attempts alike, and
// `World.close` tears it down once. Both teardowns are registered with
// the invocation's signal handler, so SIGINT runs them as it does for
// `nuka do`. A step runs through the same `executeTypedStep` that
// `nuka do` uses.
//
// No step record is written. A run tries many sequences and most of them
// pass, so the output is the scenario a person keeps, and `nuka run` of
// that scenario writes the records. Evidence files land under `scratchDir`,
// which the caller removes.

export interface WorldOptions {
  /** `baseURL` already swapped for the resolved environment's. */
  readonly config: NukadokoConfig;
  readonly vocabulary: Vocabulary;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: SecretSet;
  readonly environment: string;
  readonly policy: "read-only" | undefined;
  readonly fixtureGraph: FixtureGraph;
  readonly needsBrowser: (step: Step) => boolean;
  readonly scratchDir: string;
  /** Where the `scratch` fixture resolves a relative `copy` source. */
  readonly rootDir: string;
  /** One line per fixture whose teardown threw, already redacted. */
  readonly warn: (line: string) => void;
  readonly signal: ProcessSignal;
}

export interface World {
  readonly open: OpenSequence;
  /** Tears the process-scope fixtures down. Call once, after the last
   * sequence closed. */
  readonly close: () => Promise<void>;
}

export function openWorld(options: WorldOptions): World {
  const { config, vocabulary, secrets, policy, environment } = options;
  const stepNameOf = new Map<Step, string>(
    [...vocabulary.entries()].flatMap(([name, entry]) => (entry.kind === "typed" ? [[entry.step, name] as const] : [])),
  );
  const isRegisteredStep = registeredStepPredicate(stepNameOf.keys());
  const { signal } = options;
  let opened = 0;
  let anyFailed = false;
  const warnAll = (errors: readonly { fixture: string; message: string }[]): void => {
    for (const error of errors) options.warn(fixtureTeardownWarning(error.fixture, error.message, secrets));
  };
  const processCache = createFixtureCache();
  const close = runOnce(async () => {
    const outcome = anyFailed || signal.interrupted ? "failed" : "passed";
    warnAll(await teardownFixtureCache(processCache, outcome));
  });
  signal.setProcessCleanup(close);

  const open = async (): Promise<SequenceSession> => {
    opened += 1;
    const sequenceDir = path.join(options.scratchDir, `sequence-${opened}`);
    await mkdir(sequenceDir, { recursive: true });
    const handle = createStepContext({
      config,
      evidenceDir: sequenceDir,
      rootDir: options.rootDir,
      env: options.env,
      secrets,
      resultOf: () => undefined,
      isRegisteredStep,
      stepNameOf: (step) => stepNameOf.get(step),
      refuseMutatingPart: (part) =>
        policy === "read-only" && part.mutates
          ? new ReadOnlyEnvironmentError(stepNameOf.get(part) ?? "a step discovery never registered", environment).message
          : undefined,
    });
    const scenarioCache = createFixtureCache();
    let stepCount = 0;

    async function run(name: string, args: unknown): Promise<StepOutcome> {
      const entry = vocabulary.get(name);
      if (entry === undefined || entry.kind !== "typed") {
        return { ok: false, message: `step "${name}" is not a typed step in the vocabulary` };
      }
      if (options.needsBrowser(entry.step)) {
        return { ok: false, message: `step "${name}" needs a browser, and nuka explore runs request-only steps` };
      }
      if (policy === "read-only" && entry.step.mutates) {
        return { ok: false, message: new ReadOnlyEnvironmentError(name, environment).message };
      }
      stepCount += 1;
      const stepDir = path.join(sequenceDir, `step-${stepCount}`);
      await mkdir(stepDir, { recursive: true });
      await handle.beginStep(stepDir, name);
      const outcome = await executeTypedStep({
        name,
        step: entry.step,
        args,
        handle,
        fixtureGraph: options.fixtureGraph,
        scenarioCache,
        processCache,
        config,
      });
      await handle.endStep();
      if (outcome.status === "ok") return { ok: true, result: outcome.result };
      return { ok: false, message: redact(outcome.error.message, secrets) as string };
    }

    // A signal tears down a sequence that never reached `close`, so it did
    // not finish.
    let outcome: FixtureOutcome = "failed";
    const closeSequence = runOnce(async () => {
      const final = signal.interrupted ? "failed" : outcome;
      if (final === "failed") anyFailed = true;
      warnAll(await teardownFixtureCache(scenarioCache, final));
      await handle.dispose();
    });
    signal.setScenarioCleanup(closeSequence);

    return {
      run,
      close: async (sequenceOutcome) => {
        outcome = sequenceOutcome;
        await closeSequence();
        signal.setScenarioCleanup(null);
      },
    };
  };

  return { open, close };
}
