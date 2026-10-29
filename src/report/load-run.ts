import { readFileSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import { readStepRecord } from "../record/read-step-record.js";
import { RUN_RESULT_FILE_NAME, type RunDocument, type RunScenario } from "../record/run-result.js";
import { parseRunDocument } from "./run-document-schema.js";
import { scenarioVerdictOf, type ScenarioVerdict } from "./scenario-verdict.js";
import { readRunSources, runSourcesPath } from "../record/run-sources.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import { isWithin, realTarget } from "../record/contained-path.js";
import { RUN_FILE_DIRS, resolveRecordedPath, runRelativeDir } from "../record/state-layout.js";
import type { StepRecord } from "../record/types.js";

// Responsibility: one run directory, read back into what the report
// writers take: each feature the run parsed, and each scenario as a
// scenario record with its step records and its pickle. It reads only the
// run directory (run.json, sources.json, and steps/), so a directory
// copied off a CI machine renders the same as one in the project that ran
// it. What a writer does with the result, and where the output goes, stay
// with src/cli/report.ts.
//
// The scenario records are rebuilt from run.json rather than kept as files
// of their own: run.json already holds every field a writer reads, and a
// second copy of each scenario in the run directory would be a second
// record that could disagree with the first. Paths are rebuilt in the
// root-relative shape a record names (`runs/<run_id>/...`), and
// `resolvePath` maps any such path into wherever the run directory is now
// (src/record/state-layout.ts's `resolveRecordedPath`).
//
// A run directory copied off a CI machine is untrusted input: an edited
// record can name any path, and a writer would copy that file into the
// report. So every path a record names is resolved, symlinks included, and
// refused unless it stays inside the run directory. A run of this project's
// own gets no wider reach: a run directory copied into the state directory
// counts as own, so an exception for the project root would let an edited
// record name `.env`. Every file nuka run records is written inside its
// run directory, so the rule costs no real run anything. A refused path is
// a problem the report names, never a file it reads. The files the load
// opens itself (run.json, sources.json, and each record.json) are held to
// the same rule by their real path, since any of them can be a symlink.
//
// A pickle is found by the scenario's feature path and line, the same key
// the run used. The pickles are parsed again from sources.json, so their
// ids differ from the run's; no output keeps a pickle id across renders.

// The writers name a scenario's verdict by this type, and this file is the
// report module's surface, so it re-exports it.
export type { ScenarioVerdict };

export interface LoadedFeature {
  readonly relativePath: string;
  readonly source: string;
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

export interface LoadedScenario {
  readonly record: ScenarioRecord;
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
  readonly feature: LoadedFeature;
  readonly pickle: Pickle;
  /** What the verdict table says of this execution's row and cell. */
  readonly verdict: ScenarioVerdict | undefined;
}

export interface LoadedRun {
  readonly runDir: string;
  readonly document: RunDocument;
  readonly projectName: string | null;
  readonly features: readonly LoadedFeature[];
  readonly scenarios: readonly LoadedScenario[];
  /** One message per scenario, step record, or feature the run names and
   * this load could not read; each is part of the run the output leaves
   * out. */
  readonly problems: readonly string[];
  /** Where a path a record names is on disk. Throws for a path outside the
   * run directory, so a writer that catches it skips that file. */
  readonly resolvePath: (recordedPath: string) => string;
  /** Whether the run directory is one of this project's runs. */
  readonly ownRun: boolean;
}

export type LoadRunResult =
  | { readonly run: LoadedRun }
  | { readonly refusal: { readonly code: "run-not-found" | "run-invalid" | "run-sources-missing" | "run-sources-invalid"; readonly message: string } };

/** The scenario record a scenario of run.json stands for. Pure. */
export function scenarioRecordOf(document: RunDocument, scenario: RunScenario): ScenarioRecord {
  const inRun = (relativePath: string): string => path.join("runs", document.run_id, relativePath);
  const targetVersion = document.environments.find((environment) => environment.name === scenario.environment)?.target_version;
  return {
    nukadoko: document.nukadoko,
    scenario_record_id: scenario.scenario_record_id,
    run_id: document.run_id,
    feature: scenario.feature,
    scenario: scenario.scenario,
    line: scenario.line,
    status: scenario.status,
    // The Allure result's status details name the stop from it.
    ...(scenario.stopped !== undefined ? { stopped: scenario.stopped } : {}),
    environment: scenario.environment,
    ...(targetVersion !== undefined && targetVersion !== null ? { target_version: targetVersion } : {}),
    ...(scenario.browser !== undefined ? { browser: scenario.browser } : {}),
    started_at: scenario.started_at,
    finished_at: scenario.finished_at,
    steps: scenario.steps.map((step) => ({
      text: step.text,
      status: step.status,
      step_record_id: step.step_record_id,
      ...(step.error !== undefined ? { error: { message: step.error.message } } : {}),
    })),
    hooks: scenario.hooks,
    ...(document.commit !== null ? { git: { commit: document.commit.sha, clean: !document.commit.dirty } } : {}),
    evidence:
      scenario.evidence !== undefined
        ? { ...scenario.evidence, dir: inRun(scenario.evidence.dir) }
        : { dir: inRun(path.join(RUN_FILE_DIRS.scenarios, scenario.scenario_record_id)), screenshots: [] },
    ...(scenario.teardown_errors !== undefined ? { teardown_errors: scenario.teardown_errors } : {}),
  };
}

/** The resolver a loaded run hands its writers. Exported for its tests.
 * The root is `runDir`'s real path: for a run directory named by an
 * explicit path, that is where it points, and src/cli/report.ts refuses a
 * symlinked directory under `<stateDir>/runs/` before it gets here. */
export function containedResolver(runId: string, runDir: string, rootDir: string): (recordedPath: string) => string {
  const allowed = realTarget(runDir);
  return (recordedPath) => {
    const resolved = resolveRecordedPath(recordedPath, runId, runDir, rootDir);
    if (isWithin(allowed, realTarget(resolved))) return resolved;
    throw new Error(`${recordedPath} resolves outside the run directory, so it is not read`);
  };
}

/** `file`, a file inside the run directory, once its real path is known
 * to stay there: a symlinked run.json, sources.json, or record.json would
 * otherwise be followed out of the run. Throws for one that leaves.
 * `name` is how the message names it. */
export function containedFile(runDir: string, file: string, name: string): string {
  if (isWithin(realTarget(runDir), realTarget(file))) return file;
  throw new Error(`${name} resolves outside the run directory, so it is not read`);
}

function pickleKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

/** The run directory's run.json, checked (src/report/run-document-schema.ts),
 * or the refusal that says why it cannot be read. */
export function loadRunDocument(
  runDir: string,
): { readonly document: RunDocument } | { readonly refusal: { readonly code: "run-not-found" | "run-invalid"; readonly message: string } } {
  const runJson = path.join(runDir, RUN_RESULT_FILE_NAME);
  try {
    containedFile(runDir, runJson, runJson);
  } catch (error) {
    return { refusal: { code: "run-invalid", message: (error as Error).message } };
  }
  let text: string;
  try {
    text = readFileSync(runJson, "utf8");
  } catch {
    return { refusal: { code: "run-not-found", message: `${runDir} holds no run.json that nuka run wrote` } };
  }
  const parsed = parseRunDocument(text);
  if ("problem" in parsed) {
    return { refusal: { code: "run-invalid", message: `${path.join(runDir, RUN_RESULT_FILE_NAME)} ${parsed.problem}` } };
  }
  return { document: parsed.document };
}

/** Whether `runDir` is the directory this project's own state directory
 * holds for run `runId`: only then does a render note its files in the
 * run's exports manifest. `stateDir` is `null` when the config does not load. */
export function isOwnRun(runDir: string, rootDir: string, stateDir: string | null, runId: string): boolean {
  return stateDir !== null && path.resolve(runDir) === path.resolve(rootDir, runRelativeDir(stateDir, runId));
}

/** `rootDir` is where a path that is not inside the run resolves, the
 * project the run directory sits in when it does. `stateDir` is that
 * project's, or `null` when its config does not load, which makes no run
 * its own. */
export function loadRun(runDir: string, rootDir: string, stateDir: string | null): LoadRunResult {
  const runJson = loadRunDocument(runDir);
  if ("refusal" in runJson) return runJson;
  const document = runJson.document;
  if (!isWithin(realTarget(runDir), realTarget(runSourcesPath(runDir)))) {
    return {
      refusal: {
        code: "run-sources-invalid",
        message: `${runDir} holds a sources.json that resolves outside the run directory, so the scenarios of run ${document.run_id} cannot be parsed`,
      },
    };
  }
  const read = readRunSources(runDir);
  if ("problem" in read) {
    return {
      refusal: {
        code: read.problem === "missing" ? "run-sources-missing" : "run-sources-invalid",
        message: `${runDir} ${read.message}, so the scenarios of run ${document.run_id} cannot be parsed`,
      },
    };
  }
  const sources = read.sources;
  const ownRun = isOwnRun(runDir, rootDir, stateDir, document.run_id);
  const resolvePath = containedResolver(document.run_id, runDir, rootDir);
  const problems: string[] = [];
  const features: LoadedFeature[] = [];
  const pickles = new Map<string, { feature: LoadedFeature; pickle: Pickle }>();
  for (const { path: relativePath, source } of sources.features) {
    let parsed;
    try {
      parsed = parseFeatureSource(source, relativePath);
    } catch (error) {
      problems.push(`${relativePath} in sources.json does not parse: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const feature: LoadedFeature = { relativePath, source, ...parsed };
    features.push(feature);
    for (const pickle of parsed.pickles) {
      pickles.set(pickleKey(relativePath, pickle.location?.line ?? 0), { feature, pickle });
    }
  }
  const scenarios: LoadedScenario[] = [];
  for (const scenario of document.scenarios) {
    // An execution of the base or the old world of `nuka run --base` is a
    // cell of the table, not a test result: a base cell that fails is how a
    // row is proven, and an old one ran the base's feature file, which
    // sources.json does not hold. The formats render head's executions,
    // each with its row's verdict.
    if (scenario.world !== undefined) continue;
    const match = pickles.get(pickleKey(scenario.feature, scenario.line));
    if (match === undefined) {
      problems.push(`${scenario.feature}:${scenario.line} (${scenario.scenario_record_id}) matches no scenario in sources.json`);
      continue;
    }
    const stepRecords = new Map<string, StepRecord | null>();
    for (const step of scenario.steps) {
      if (step.step_record_id === null || step.record === null || stepRecords.has(step.step_record_id)) continue;
      let stepRecord: StepRecord | null = null;
      try {
        const recordDir = containedResolver(document.run_id, runDir, runDir)(step.record);
        containedFile(runDir, path.join(recordDir, "record.json"), `${step.record}/record.json`);
        stepRecord = readStepRecord(recordDir);
        if (stepRecord === null) problems.push(`${step.record}/record.json of ${scenario.scenario_record_id} could not be read`);
      } catch (error) {
        problems.push(`${scenario.scenario_record_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      stepRecords.set(step.step_record_id, stepRecord);
    }
    scenarios.push({
      record: scenarioRecordOf(document, scenario),
      stepRecords,
      feature: match.feature,
      pickle: match.pickle,
      verdict: scenarioVerdictOf(document.table, scenario.feature, scenario.line, scenario.environment),
    });
  }
  return {
    run: {
      runDir,
      document,
      projectName: sources.project,
      features,
      scenarios,
      problems,
      resolvePath,
      ownRun,
    },
  };
}
