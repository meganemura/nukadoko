import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkExploreDeclarations } from "../check/explore-check.js";
import { loadConfig } from "../config/load-config.js";
import { loadEnvFiles } from "../context/env.js";
import { discoverSteps } from "../discover/discover-steps.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  ReadOnlyEnvironmentError,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import {
  exploreModel,
  exploreRelation,
  openWorld,
  renderScenario,
  type PlannedStep,
  type StepOutcome,
} from "../explore/index.js";
import { buildFixtureGraph } from "../fixture/graph.js";
import { stepNeeds } from "../fixture/step-needs.js";
import {
  formatFixtureDefinitionIssues,
  formatFixtureIssues,
  knownFixtureNames,
  validateFixtureDefinitions,
  validateStepFixtures,
} from "../fixture/validate-fixtures.js";
import { buildStepBindings, type StepBinding } from "../run/match-step.js";
import { installProcessSignalHandlers } from "../run/process-signal.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import type { WritableSink } from "../sink/writable-sink.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { Step } from "../step/define-step.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import { assertFeaturesDirExists, formatVocabularyError } from "./vocabulary.js";

// Responsibility: `nuka explore`'s wiring. Setup refuses before any step
// runs: a file that is not a model or a relation, a finding `nuka check`
// would report for it, a fixture problem `nuka do` would refuse on. Then
// the model or the relation runs, and on failure stdout gets the scenario
// to paste, with the command that reruns it. stdout stays empty on a pass,
// so a caller can tell the two apart without reading stderr. `--json`
// prints one object on stdout instead, for a pass too. It is written to
// stdout only, never under the state directory, so `nuka accept` and
// `nuka tend` never read an explore run as the newest run.

export const DEFAULT_EXPLORE_RUNS = 20;
export const DEFAULT_EXPLORE_LENGTH = 10;

export interface RunExploreOptions {
  readonly rootDir: string;
  readonly file: string;
  /** `null` picks a seed, and the output prints it. */
  readonly seed: number | null;
  readonly runs: number;
  readonly length: number;
  readonly env: string | null;
  /** One JSON object on stdout, for a pass too, in place of the scenario. */
  readonly json: boolean;
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
}

function positiveInteger(flag: string, value: number, stderr: WritableSink): boolean {
  if (Number.isInteger(value) && value >= 1) return true;
  stderr.write(`${flag} must be a whole number of 1 or more (got ${value}).\n`);
  return false;
}

/** A relation has no seed: its source is declared, not generated. */
function rerunCommand(options: RunExploreOptions, seed: number | null): string {
  const generated = seed === null ? "" : ` --seed ${seed} --runs ${options.runs} --length ${options.length}`;
  const env = options.env === null ? "" : ` --env ${shellWord(options.env)}`;
  return `nuka explore ${shellWord(options.file)}${generated}${env}`;
}

/** The rerun line is meant to be pasted into a shell, so a path with a
 * space or a quote in it is single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export async function runExplore(options: RunExploreOptions): Promise<number> {
  const { rootDir, stdout, stderr } = options;
  if (!positiveInteger("--runs", options.runs, stderr) || !positiveInteger("--length", options.length, stderr)) {
    return 1;
  }
  if (options.seed !== null && !(Number.isInteger(options.seed) && options.seed >= 0 && options.seed < 2 ** 32)) {
    stderr.write(`--seed must be a whole number from 0 to 4294967295 (got ${options.seed}).\n`);
    return 1;
  }
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 32);

  let config;
  let resolvedEnv: ResolvedEnvironment;
  try {
    config = await loadConfig(rootDir);
    resolvedEnv = resolveEnvironment(config, options.env ?? DEFAULT_ENVIRONMENT_NAME, options.env !== null);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let discovery;
  try {
    discovery = await discoverSteps(rootDir, config.featuresDir, { keepRegistered: true });
    assertFeaturesDirExists(rootDir, config);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }
  try {
    return await exploreDiscovered(options, seed, config, resolvedEnv, discovery);
  } finally {
    await discovery.unregister();
  }
}

async function exploreDiscovered(
  options: RunExploreOptions,
  seed: number,
  config: Awaited<ReturnType<typeof loadConfig>>,
  resolvedEnv: ResolvedEnvironment,
  discovery: Awaited<ReturnType<typeof discoverSteps>>,
): Promise<number> {
  const { rootDir, stdout, stderr } = options;
  const { vocabulary, models, relations, compatParameterTypes } = discovery;
  const target = path.resolve(rootDir, options.file);
  const model = models.find((entry) => entry.filePath === target);
  const relation = relations.find((entry) => entry.filePath === target);
  if (model === undefined && relation === undefined) {
    const known = [...models, ...relations].map((entry) => path.relative(rootDir, entry.filePath)).sort();
    stderr.write(
      `${options.file} is not a model or a relation that discovery found under ${config.featuresDir}. ` +
        (known.length > 0 ? `Found: ${known.join(", ")}\n` : "Discovery found none.\n"),
    );
    return 1;
  }

  const fixtureGraph = buildFixtureGraph(config);
  const needsBrowser = (step: Step): boolean => stepNeeds(step, fixtureGraph).needsBrowser;
  const findings = checkExploreDeclarations({
    vocabulary,
    models: model === undefined ? [] : [model],
    relations: relation === undefined ? [] : [relation],
    needsBrowser,
  });
  if (findings.length > 0) {
    for (const finding of findings) stderr.write(`${finding.code}: ${finding.message}\n`);
    return 1;
  }
  const definitionIssues = validateFixtureDefinitions(config);
  if (definitionIssues.length > 0) {
    stderr.write(`${formatFixtureDefinitionIssues(definitionIssues)}\n`);
    return 1;
  }
  const declaredSteps =
    model !== undefined
      ? Object.keys(model.model.commands)
      : relation!.relation.source.map((entry) => nameOf(vocabulary, entry.step)!);
  const knownFixtures = knownFixtureNames(config);
  const fixtureIssues = [...new Set(declaredSteps)].flatMap((name) => {
    const entry = vocabulary.get(name);
    return entry?.kind === "typed" ? validateStepFixtures(name, entry.step, knownFixtures) : [];
  });
  if (fixtureIssues.length > 0) {
    stderr.write(`${formatFixtureIssues(fixtureIssues)}\n`);
    return 1;
  }
  if (resolvedEnv.policy === "read-only") {
    const mutating = [...new Set(declaredSteps)].filter((name) => {
      const entry = vocabulary.get(name);
      return entry?.kind === "typed" && entry.step.mutates;
    });
    if (mutating.length > 0) {
      for (const name of mutating) {
        stderr.write(`${new ReadOnlyEnvironmentError(name, resolvedEnv.name).message}\n`);
      }
      return 1;
    }
  }

  let bindings: readonly StepBinding[];
  try {
    bindings = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  const env = loadEnvFiles(rootDir, resolvedEnv.envFiles);
  const classification = await classifyEnvFiles(rootDir, resolvedEnv.envFiles);
  const secrets = buildSecretSet(rootDir, {
    secretSourceFiles: classification.secretSource,
    trackedFiles: classification.tracked,
    publicKeys: config.secrets.public,
    redactKeys: config.secrets.redact,
  });

  const scratchDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-explore-"));
  const signal = installProcessSignalHandlers();
  // `process.exit` from the signal handler does not run the `finally` below.
  signal.setSignalFinalizer(() => rm(scratchDir, { recursive: true, force: true }));
  const world = openWorld({
    config: { ...config, baseURL: resolvedEnv.baseURL },
    vocabulary,
    env,
    secrets,
    environment: resolvedEnv.name,
    policy: resolvedEnv.policy,
    fixtureGraph,
    needsBrowser,
    scratchDir,
    warn: (line) => stderr.write(`${line}\n`),
    signal,
  });
  const { open } = world;
  try {
    const render = (title: string, steps: readonly PlannedStep[], notes: ReadonlyMap<number, string>) =>
      renderScenario({ title, steps, notes, vocabulary, bindings });
    const failedNote = (index: number, message: string) => new Map([[index, `step ${index + 1} failed: ${message}`]]);
    const emit = (json: Record<string, unknown>, text: readonly string[]) => {
      if (options.json) stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      else if (text.length > 0) stdout.write(`${text.join("\n")}\n`);
    };
    const file = path.relative(rootDir, target);

    if (model !== undefined) {
      const result = await exploreModel({ model: model.model, seed, runs: options.runs, length: options.length, open });
      const rerun = rerunCommand(options, seed);
      const head = { kind: "model", file, verdict: result.status === "model-error" ? "error" : result.status, seed, runs: options.runs, length: options.length };
      if (result.status === "passed") {
        emit({ ...head, steps: result.steps, rerun }, []);
        stderr.write(`Passed: ${plural(result.runs, "run")}, ${plural(result.steps, "step")}, seed ${seed}. Rerun: ${rerun}\n`);
        return 0;
      }
      if (result.status === "model-error") {
        emit({ ...head, rerun, run: result.run, message: result.message }, []);
        stderr.write(`The model failed on run ${result.run}, seed ${seed}: ${result.message}\n`);
        return 1;
      }
      const scenario = await render("(name me)", result.shrunk, failedNote(result.failure.index, result.failure.message));
      emit(
        {
          ...head,
          rerun,
          run: result.run,
          found_steps: result.found.length,
          shrunk_steps: result.shrunk.length,
          shrink_attempts: result.shrinkAttempts,
          failure: result.failure,
          steps: stepResults(result.shrunk, result.outcomes),
          scenario: lines(scenario),
        },
        [
          `# ${rerun}`,
          `# Run ${result.run} of ${options.runs} failed after ${plural(result.found.length, "step")}. ` +
            `Shrunk to ${plural(result.shrunk.length, "step")} in ${plural(result.shrinkAttempts, "attempt")}.`,
          ...scenario,
        ],
      );
      stderr.write(
        `Failed: run ${result.run}, seed ${seed}, shrunk to ${plural(result.shrunk.length, "step")}. ` +
          "The scenario is on stdout.\n",
      );
      return 1;
    }

    const declared = relation!.relation;
    const result = await exploreRelation({
      relation: declared,
      resolve: (step) => {
        const name = nameOf(vocabulary, step);
        if (name === undefined) return { error: "this step is not in the vocabulary" };
        if (needsBrowser(step)) return { error: `step "${name}" needs a browser, and nuka explore runs request-only steps` };
        if (resolvedEnv.policy === "read-only" && step.mutates) {
          return { error: new ReadOnlyEnvironmentError(name, resolvedEnv.name).message };
        }
        return { name };
      },
      open,
    });
    const rerun = rerunCommand(options, null);
    const head = { kind: "relation", file, name: declared.name, verdict: result.status === "relation-error" ? "error" : result.status };
    if (result.status === "passed") {
      emit({ ...head, rerun }, []);
      stderr.write(`Passed: relation "${declared.name}". Rerun: ${rerun}\n`);
      return 0;
    }
    if (result.status === "relation-error") {
      emit({ ...head, rerun, message: result.message }, []);
      stderr.write(`The relation "${declared.name}" failed before it ran: ${result.message}\n`);
      return 1;
    }
    const { failure } = result;
    const note = (sequence: "source" | "follow"): Map<number, string> =>
      failure.sequence === sequence ? failedNote(failure.index, failure.message) : new Map();
    const sourceScenario = await render(`(name me) source of "${declared.name}"`, result.source, note("source"));
    const followScenario = await render(`(name me) follow of "${declared.name}"`, result.follow, note("follow"));
    emit(
      {
        ...head,
        rerun,
        failure,
        source: { steps: stepResults(result.source, result.sourceOutcomes), scenario: lines(sourceScenario) },
        follow: { steps: stepResults(result.follow, result.followOutcomes), scenario: lines(followScenario) },
      },
      [
        `# ${rerun}`,
        `# Relation "${declared.name}" failed${failure.sequence === "relate" ? `: ${oneLine(failure.message)}` : ` in its ${failure.sequence} sequence.`}`,
        ...sourceScenario,
        "",
        ...followScenario,
      ],
    );
    stderr.write(`Failed: relation "${declared.name}". Both scenarios are on stdout.\n`);
    return 1;
  } finally {
    await world.close();
    signal.stop();
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function lines(scenario: readonly string[]): string {
  return scenario.map((line) => `${line}\n`).join("");
}

/** A step past the one that failed, or in a sequence that never ran, is
 * `not-run`. Values go out in stored form, as a step record writes them. */
function stepResults(steps: readonly PlannedStep[], outcomes: readonly StepOutcome[]): unknown[] {
  return steps.map((planned, index) => {
    const head = { step: planned.name, args: toStoredForm(planned.args) };
    const outcome = outcomes[index];
    if (outcome === undefined) return { ...head, status: "not-run" };
    return outcome.ok
      ? { ...head, status: "ok", result: toStoredForm(outcome.result) }
      : { ...head, status: "failed", message: outcome.message };
  });
}

function nameOf(vocabulary: Vocabulary, step: Step): string | undefined {
  for (const [name, entry] of vocabulary) {
    if (entry.kind === "typed" && entry.step === step) return name;
  }
  return undefined;
}
