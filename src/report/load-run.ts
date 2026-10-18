import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import { readStepRecord } from "../record/read-step-record.js";
import { RUN_RESULT_FILE_NAME, type RunDocument, type RunScenario } from "../record/run-result.js";
import { parseRunDocument } from "./run-document-schema.js";
import { readRunSources } from "../record/run-sources.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
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
// refused unless it stays inside the run directory. The one exception is a
// run of this project's own, whose records may name a file elsewhere in
// the project; even then the path has to stay inside the project root. A
// refused path is a problem the report names, never a file it reads.
//
// A pickle is found by the scenario's feature path and line, the same key
// the run used. The pickles are parsed again from sources.json, so their
// ids differ from the run's; no output keeps a pickle id across renders.

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
   * run directory (or, for this project's own run, outside the project
   * root), so a writer that catches it skips that file. */
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

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** `target` with every symlink resolved, or, when it does not exist, the
 * nearest existing parent resolved with the rest appended, so a missing
 * file behind a symlinked directory still resolves to where it would be. */
function realTarget(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realTarget(parent), path.basename(absolute));
  }
}

/** The resolver a loaded run hands its writers. Exported for its tests. */
export function containedResolver(runId: string, runDir: string, rootDir: string, ownRun: boolean): (recordedPath: string) => string {
  const allowed = [realTarget(runDir), ...(ownRun ? [realTarget(rootDir)] : [])];
  return (recordedPath) => {
    const resolved = resolveRecordedPath(recordedPath, runId, runDir, rootDir);
    if (allowed.some((root) => isWithin(root, realTarget(resolved)))) return resolved;
    throw new Error(`${recordedPath} resolves outside the ${ownRun ? "project" : "run directory"}, so it is not read`);
  };
}

function pickleKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

/** The run directory's run.json, checked (src/report/run-document-schema.ts),
 * or the refusal that says why it cannot be read. */
export function loadRunDocument(
  runDir: string,
): { readonly document: RunDocument } | { readonly refusal: { readonly code: "run-not-found" | "run-invalid"; readonly message: string } } {
  let text: string;
  try {
    text = readFileSync(path.join(runDir, RUN_RESULT_FILE_NAME), "utf8");
  } catch {
    return { refusal: { code: "run-not-found", message: `${runDir} holds no run.json that nuka run wrote` } };
  }
  const parsed = parseRunDocument(text);
  if ("problem" in parsed) {
    return { refusal: { code: "run-invalid", message: `${path.join(runDir, RUN_RESULT_FILE_NAME)} ${parsed.problem}` } };
  }
  return { document: parsed.document };
}

/** `rootDir` is where a path that is not inside the run resolves, the
 * project the run directory sits in when it does. `stateDir` is that
 * project's, or `null` when its config does not load, which makes no run
 * its own. */
export function loadRun(runDir: string, rootDir: string, stateDir: string | null): LoadRunResult {
  const runJson = loadRunDocument(runDir);
  if ("refusal" in runJson) return runJson;
  const document = runJson.document;
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
  const ownRun = stateDir !== null && path.resolve(runDir) === path.resolve(rootDir, runRelativeDir(stateDir, document.run_id));
  const resolvePath = containedResolver(document.run_id, runDir, rootDir, ownRun);
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
        stepRecord = readStepRecord(containedResolver(document.run_id, runDir, runDir, false)(step.record));
        if (stepRecord === null) problems.push(`${step.record}/record.json of ${scenario.scenario_record_id} could not be read`);
      } catch (error) {
        problems.push(`${scenario.scenario_record_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      stepRecords.set(step.step_record_id, stepRecord);
    }
    scenarios.push({ record: scenarioRecordOf(document, scenario), stepRecords, feature: match.feature, pickle: match.pickle });
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
