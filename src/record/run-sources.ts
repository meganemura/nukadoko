import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDir } from "./run-exports.js";
import { SCHEMA_VERSIONS, versioned } from "./schema-version.js";

// Responsibility: sources.json, the feature text one `nuka run` parsed its
// scenarios from, kept in the run's own directory beside run.json.
// `nuka report` renders a run long after the run, often on another machine
// and after the feature files have moved on. An Allure result's identity
// and a cucumber-messages stream both need the parsed Gherkin document of
// the scenario as it ran, so the run keeps the text it parsed instead of
// trusting whatever the working tree holds later. The project name rides
// along for the same reason: it is part of an Allure result's `fullName`,
// and a copied run directory has no package.json beside it.
//
// The alternative refused: putting the text in run.json. run.json is also
// what `nuka run --json` prints, and an agent reading the result does not
// need every feature file on its stdout.

export const RUN_SOURCES_FILE_NAME = "sources.json";

export interface RunSources {
  /** The host project's package.json `name`, or `null` without one. */
  readonly project: string | null;
  /** One entry per feature file the run selected, in run order. `path` is
   * relative to the project root, as run.json's `feature` names it. */
  readonly features: readonly { readonly path: string; readonly source: string }[];
}

export function runSourcesPath(runDirectory: string): string {
  return path.join(runDirectory, RUN_SOURCES_FILE_NAME);
}

/** A rename makes the write atomic, as for run.json. */
export function writeRunSources(rootDir: string, stateDir: string, runId: string, sources: RunSources): void {
  const filePath = runSourcesPath(runDir(rootDir, stateDir, runId));
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(versioned("run_sources", sources), null, 2)}\n`);
  renameSync(temporary, filePath);
}

/** The sources.json in `runDirectory`, or `null` when it is missing, does
 * not parse, or carries another schema version. */
export function readRunSources(runDirectory: string): RunSources | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runSourcesPath(runDirectory), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const document = parsed as Record<string, unknown>;
    if (document.schema_version !== SCHEMA_VERSIONS.run_sources) return null;
    if (document.project !== null && typeof document.project !== "string") return null;
    if (!Array.isArray(document.features)) return null;
    const features = document.features.filter(
      (entry): entry is { path: string; source: string } =>
        entry !== null && typeof entry === "object" && typeof entry.path === "string" && typeof entry.source === "string",
    );
    if (features.length !== document.features.length) return null;
    return { project: document.project as string | null, features: features.map(({ path: p, source }) => ({ path: p, source })) };
  } catch {
    return null;
  }
}
