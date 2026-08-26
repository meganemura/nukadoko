import { readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the two disk-touching pieces of a step's or a scenario's
// own Allure identity — resolving the host project's own package.json
// `name` (or `null` when there isn't one), and assembling the `fullName`
// string both a step's own test and a scenario's own test use as their
// human-readable identifier.
//
// `fullName` alone is never a promise of continuity across runs at either
// grain — that promise lives in whichever parameters ride alongside it
// (src/report/allure/map-scenario.ts's own header spells out why a step's
// own test can never make that promise honestly, and why a scenario's own
// test now can). `buildFullName` stays a plain, readable identifier,
// `{project}:{featurePath}#{name}`, where the caller decides what `name`
// is: emitter.ts passes `${pickle.name}#${step name}` for a step's own
// test (the historic `{project}:{featurePath}#{scenario}#{step text}`
// shape) and bare `pickle.name` for a scenario's own test — the
// run/scenario/step-scoped values that deliberately keep two runs of a
// *step's* own test from linking live in `mapStep`'s own
// `identityParameters` instead, never mixed into this string either way.
//
// Deliberately does NOT compute `testCaseId`: emitter.ts leaves that field
// unset on the `TestResult` it builds and lets allure-js-commons' own
// `ReporterRuntime.stopTest` fill it in from `fullName` itself (`md5(
// fullName)`, verified against that SDK's own `getTestResultTestCaseId`) the
// moment it runs — no reason to reimplement that one-line formula here.

/** `null` when `<rootDir>/package.json` doesn't exist, isn't readable,
 * isn't valid JSON, or has no string `name` — every one of those collapses
 * to "no project name" the same way, since a caller building
 * `fullName` treats all of them identically. */
export function resolveProjectName(rootDir: string): string | null {
  try {
    const raw = readFileSync(path.join(rootDir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "name" in parsed) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Normalizes a root-relative filesystem path to the POSIX separators
 * `fullName`/`posixPath` require, regardless
 * of which separator the host OS's own `path.relative` produced. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/** `${projectName}:${posixPath}#${name}`, or `${posixPath}#${name}` when
 * there is no project name. emitter.ts calls this once per scenario's own
 * test, `name` = bare `pickle.name` — this file's own header. */
export function buildFullName(projectName: string | null, posixPath: string, name: string): string {
  return projectName === null ? `${posixPath}#${name}` : `${projectName}:${posixPath}#${name}`;
}

/** The report tree's own grouping path for one scenario's test: every
 * directory segment of its feature file's path, then the Feature's own
 * name, with the project name prepended when there is one. Verified against
 * a real allure-cucumberjs 3.10.2 run's own output (a captured result.json's
 * `titlePath`): `features/sample.feature` under a project named
 * `allure-sample` produced `["allure-sample", "features", "Sample feature
 * for allure output inspection"]` — the file name itself (`sample.feature`)
 * never appears, only the directories above it. A feature file directly at
 * the project root (no directory segment at all) still gets the Feature
 * name as this path's only entry (or its only entry after the project
 * name). */
export function buildTitlePath(projectName: string | null, posixPath: string, featureName: string): string[] {
  const directorySegments = posixPath.split("/").slice(0, -1);
  const titlePath = featureName !== "" ? [...directorySegments, featureName] : directorySegments;
  return projectName === null ? titlePath : [projectName, ...titlePath];
}
