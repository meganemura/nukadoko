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
import { shellWord } from "../shell/shell-word.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { isModel, type RelationSource, type RelationStep } from "../step/define-explore.js";
import type { Step } from "../step/define-step.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import { formatFinding, withoutWarningPrefix, type Finding } from "../finding/finding.js";
import type { RefusalCode } from "./refusal-codes.js";
import { formatEnvelope, refuse, withHint } from "./refusal.js";
import { assertFeaturesDirExists } from "./vocabulary.js";

// Responsibility: `nuka experimental explore`'s wiring. Setup refuses before any step
// runs: a file that is not a model or a relation, a finding `nuka check`
// would report for it, a fixture problem `nuka do` would refuse on. Then
// the model or the relation runs, and on failure stdout gets the scenario
// to paste, with the command that reruns it. stdout stays empty on a pass,
// so a caller can tell the two apart without reading stderr. `--json`
// prints one object on stdout instead, for a pass too. It is written to
// stdout only, never under the state directory, so the run summary and
// `nuka tend` never read an explore run as the newest run.


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
  /** Findings the invocation raised before the command ran, such as a
   * missing config file, which `--json` carries in the envelope. */
  readonly notices?: readonly Finding[];
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
}

function positiveIntegerRefusal(flag: string, value: number): string | null {
  return Number.isInteger(value) && value >= 1 ? null : `${flag} must be a whole number of 1 or more (got ${value}).`;
}

function refuseExplore(
  options: RunExploreOptions,
  error: unknown,
  code: RefusalCode = "unexpected-error",
  before: readonly Finding[] = [],
): number {
  return refuse({ ...options, command: "experimental explore" }, error, code, undefined, [...(options.notices ?? []), ...before]);
}

/** A relation with a declared source has no seed. */
function rerunCommand(options: RunExploreOptions, seed: number | null): string {
  const generated = seed === null ? "" : ` --seed ${seed} --runs ${options.runs} --length ${options.length}`;
  const env = options.env === null ? "" : ` --env ${shellWord(options.env)}`;
  return `nuka experimental explore ${shellWord(options.file)}${generated}${env}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export async function runExplore(options: RunExploreOptions): Promise<number> {
  const { rootDir } = options;
  const flagRefusal =
    positiveIntegerRefusal("--runs", options.runs) ?? positiveIntegerRefusal("--length", options.length);
  if (flagRefusal !== null) return refuseExplore(options, flagRefusal, "invalid-value");
  if (options.seed !== null && !(Number.isInteger(options.seed) && options.seed >= 0 && options.seed < 2 ** 32)) {
    return refuseExplore(options, `--seed must be a whole number from 0 to 4294967295 (got ${options.seed}).`, "invalid-value");
  }
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 32);

  let config;
  let resolvedEnv: ResolvedEnvironment;
  try {
    config = await loadConfig(rootDir);
    resolvedEnv = resolveEnvironment(config, options.env ?? DEFAULT_ENVIRONMENT_NAME, options.env !== null);
  } catch (error) {
    return refuseExplore(options, error);
  }

  let discovery;
  try {
    discovery = await discoverSteps(rootDir, config.featuresDir);
    assertFeaturesDirExists(rootDir, config);
  } catch (error) {
    return refuseExplore(options, error);
  }
  return exploreDiscovered(options, seed, config, resolvedEnv, discovery);
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
  // Under `--json` every finding goes in the one document, so a warning
  // waits for it; in text it goes to stderr when it happens.
  const findings: Finding[] = [...(options.notices ?? [])];
  const warn = (finding: Finding): void => {
    if (options.json) findings.push(finding);
    else stderr.write(formatFinding(withHint(finding)));
  };
  const target = path.resolve(rootDir, options.file);
  const model = models.find((entry) => entry.filePath === target);
  const relation = relations.find((entry) => entry.filePath === target);
  if (model === undefined && relation === undefined) {
    const known = [...models, ...relations].map((entry) => path.relative(rootDir, entry.filePath)).sort();
    return refuseExplore(
      options,
      `${options.file} is not a model or a relation that discovery found under ${config.featuresDir}. ` +
        (known.length > 0 ? `Found: ${known.join(", ")}` : "Discovery found none."),
      "explore-target-unknown",
    );
  }

  const fixtureGraph = buildFixtureGraph(config);
  const needsBrowser = (step: Step): boolean => stepNeeds(step, fixtureGraph).needsBrowser;
  const declarationFindings = checkExploreDeclarations({
    vocabulary,
    models: model === undefined ? [] : [model],
    relations: relation === undefined ? [] : [relation],
    needsBrowser,
  });
  if (declarationFindings.length > 0) {
    const count = declarationFindings.length;
    return refuseExplore(
      options,
      `nuka experimental explore did not start: ${count} ${count === 1 ? "finding" : "findings"} in its declarations`,
      "check-errors",
      declarationFindings.map((finding) => ({ severity: "error", ...finding })),
    );
  }
  const definitionIssues = validateFixtureDefinitions(config);
  if (definitionIssues.length > 0) {
    return refuseExplore(options, formatFixtureDefinitionIssues(definitionIssues), "step-inputs-invalid");
  }
  const declaredSteps =
    model !== undefined
      ? Object.keys(model.model.commands)
      : relationSourceSteps(relation!.relation.source, vocabulary);
  const knownFixtures = knownFixtureNames(config);
  const fixtureIssues = [...new Set(declaredSteps)].flatMap((name) => {
    const entry = vocabulary.get(name);
    return entry?.kind === "typed" ? validateStepFixtures(name, entry.step, knownFixtures) : [];
  });
  if (fixtureIssues.length > 0) {
    return refuseExplore(options, formatFixtureIssues(fixtureIssues), "step-inputs-invalid");
  }
  if (resolvedEnv.policy === "read-only") {
    const mutating = [...new Set(declaredSteps)].filter((name) => {
      const entry = vocabulary.get(name);
      return entry?.kind === "typed" && entry.step.mutates;
    });
    if (mutating.length > 0) {
      return refuseExplore(
        options,
        mutating.map((name) => new ReadOnlyEnvironmentError(name, resolvedEnv.name).message).join("; "),
        "read-only-environment",
      );
    }
  }

  let bindings: readonly StepBinding[];
  try {
    bindings = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  } catch (error) {
    return refuseExplore(options, error);
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
    rootDir,
    warn: (line) => warn({ severity: "warning", code: "fixture-teardown-failed", message: withoutWarningPrefix(line) }),
    signal,
  });
  const { open } = world;
  try {
    const render = (title: string, steps: readonly PlannedStep[], notes: ReadonlyMap<number, string>) =>
      renderScenario({ title, steps, notes, vocabulary, bindings });
    const failedNote = (index: number, message: string) => new Map([[index, `step ${index + 1} failed: ${message}`]]);
    const file = path.relative(rootDir, target);
    // A pass prints one summary line in text; `--json` already holds it.
    const passedLine = (line: string) => {
      if (!options.json) stderr.write(`${line}\n`);
    };
    // A failure is a finding whose `do` reruns the same exploration, the
    // way a failed scenario's finding reruns that scenario.
    const failed = (code: "explore-failed" | "explore-error", message: string, rerun: string) =>
      warn({ severity: "failed", code, file, message, do: rerun });
    const emit = (exitCode: number, json: Record<string, unknown>, text: readonly string[]) => {
      if (options.json) stdout.write(formatEnvelope("experimental explore", exitCode, findings, json));
      else if (text.length > 0) stdout.write(`${text.join("\n")}\n`);
    };

    if (model !== undefined) {
      const result = await exploreModel({ model: model.model, seed, runs: options.runs, length: options.length, open });
      const rerun = rerunCommand(options, seed);
      const head = { kind: "model", file, seed, runs: options.runs, length: options.length };
      if (result.status === "passed") {
        emit(0, { ...head, steps: result.steps, rerun }, []);
        passedLine(`Passed: ${plural(result.runs, "run")}, ${plural(result.steps, "step")}, seed ${seed}. Rerun: ${rerun}`);
        return 0;
      }
      if (result.status === "model-error") {
        failed("explore-error", `The model failed on run ${result.run}, seed ${seed}: ${result.message}`, rerun);
        emit(1, { ...head, rerun, run: result.run, message: result.message }, []);
        return 1;
      }
      const scenario = await render("(name me)", result.shrunk, failedNote(result.failure.index, result.failure.message));
      failed(
        "explore-failed",
        `Run ${result.run}, seed ${seed}, shrunk to ${plural(result.shrunk.length, "step")}; the scenario is on stdout`,
        rerun,
      );
      emit(
        1,
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
      return 1;
    }

    const declared = relation!.relation;
    const result = await exploreRelation({
      relation: declared,
      resolve: (step) => {
        const name = nameOf(vocabulary, step);
        if (name === undefined) return { error: "this step is not in the vocabulary" };
        if (needsBrowser(step)) return { error: `step "${name}" needs a browser, and nuka experimental explore runs request-only steps` };
        if (resolvedEnv.policy === "read-only" && step.mutates) {
          return { error: new ReadOnlyEnvironmentError(name, resolvedEnv.name).message };
        }
        return { name };
      },
      open,
      seed,
      runs: options.runs,
      length: options.length,
    });
    const generated = !Array.isArray(declared.source);
    const rerun = rerunCommand(options, generated ? seed : null);
    const head = {
      kind: "relation",
      file,
      name: declared.name,
      ...(generated ? { seed, runs: options.runs, length: options.length } : {}),
    };
    if (result.status === "passed") {
      emit(0, { ...head, rerun }, []);
      const counts = generated ? `, ${plural(options.runs, "run")}, seed ${seed}` : "";
      passedLine(`Passed: relation "${declared.name}"${counts}. Rerun: ${rerun}`);
      return 0;
    }
    if (result.status === "relation-error") {
      const where = result.generated === undefined ? "" : ` on run ${result.generated.run}, seed ${seed}`;
      failed("explore-error", `The relation "${declared.name}" failed before it ran${where}: ${result.message}`, rerun);
      emit(1, { ...head, rerun, ...(result.generated === undefined ? {} : { run: result.generated.run }), message: result.message }, []);
      return 1;
    }
    const found = result.generated;
    const { failure } = result;
    const note = (sequence: "source" | "follow"): Map<number, string> =>
      failure.sequence === sequence ? failedNote(failure.index, failure.message) : new Map();
    const sourceScenario = await render(`(name me) source of "${declared.name}"`, result.source, note("source"));
    const followScenario = await render(`(name me) follow of "${declared.name}"`, result.follow, note("follow"));
    failed("explore-failed", `Relation "${declared.name}" failed; both scenarios are on stdout`, rerun);
    emit(
      1,
      {
        ...head,
        rerun,
        ...(found === undefined
          ? {}
          : {
              run: found.run,
              found_steps: found.foundSteps,
              shrunk_steps: result.source.length,
              shrink_attempts: found.shrinkAttempts,
            }),
        failure,
        source: { steps: stepResults(result.source, result.sourceOutcomes), scenario: lines(sourceScenario) },
        follow: { steps: stepResults(result.follow, result.followOutcomes), scenario: lines(followScenario) },
      },
      [
        `# ${rerun}`,
        `# Relation "${declared.name}" failed${failure.sequence === "relate" ? `: ${oneLine(failure.message)}` : ` in its ${failure.sequence} sequence.`}`,
        ...(found === undefined
          ? []
          : [
              `# Run ${found.run} of ${options.runs} failed with ${plural(found.foundSteps, "source step")}. ` +
                `Shrunk to ${plural(result.source.length, "source step")} in ${plural(found.shrinkAttempts, "attempt")}.`,
            ]),
        ...sourceScenario,
        "",
        ...followScenario,
      ],
    );
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
      ? { ...head, status: "passed", result: toStoredForm(outcome.result) }
      : { ...head, status: "failed", message: outcome.message };
  });
}

/** The steps setup can judge before a run: a declared source's, or a
 * model source's commands. A source drawn by a function names its steps
 * only when it runs, and each is judged then. */
function relationSourceSteps(source: RelationSource, vocabulary: Vocabulary): string[] {
  if (isModel(source)) return Object.keys(source.commands);
  if (!Array.isArray(source)) return [];
  return (source as readonly RelationStep[]).map((entry) => nameOf(vocabulary, entry.step)!);
}

function nameOf(vocabulary: Vocabulary, step: Step): string | undefined {
  for (const [name, entry] of vocabulary) {
    if (entry.kind === "typed" && entry.step === step) return name;
  }
  return undefined;
}
