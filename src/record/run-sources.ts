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

/** The sources.json in `runDirectory`, or which of three things is wrong
 * with it: missing (an earlier release wrote none), corrupt (it does not
 * parse, or lacks a field), or written by a release with another schema
 * version. Each one is refused with its own message. */
export function readRunSources(
  runDirectory: string,
): { readonly sources: RunSources } | { readonly problem: "missing" | "corrupt" | "version"; readonly message: string } {
  let text: string;
  try {
    text = readFileSync(runSourcesPath(runDirectory), "utf8");
  } catch {
    return { problem: "missing", message: "holds no sources.json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: "corrupt", message: `holds a sources.json that does not parse as JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const document = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (document.schema_version !== SCHEMA_VERSIONS.run_sources) {
    return {
      problem: "version",
      message: `holds a sources.json with schema_version ${JSON.stringify(document.schema_version ?? null)}, and this release reads ${SCHEMA_VERSIONS.run_sources}`,
    };
  }
  const features = Array.isArray(document.features) ? document.features : null;
  const valid =
    (document.project === null || typeof document.project === "string") &&
    features !== null &&
    features.every((entry) => entry !== null && typeof entry === "object" && typeof entry.path === "string" && typeof entry.source === "string");
  if (!valid) {
    return { problem: "corrupt", message: "holds a sources.json without a string-or-null project and a features list of path and source strings" };
  }
  return {
    sources: {
      project: document.project as string | null,
      features: (features as { path: string; source: string }[]).map(({ path: p, source }) => ({ path: p, source })),
    },
  };
}
