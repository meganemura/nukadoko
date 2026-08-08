import { readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the two disk-touching pieces of a step's own Allure
// identity — resolving the host project's own package.json `name` (or
// `null` when there isn't one), and assembling the `fullName` string a
// step's own test uses as its human-readable identifier.
//
// `fullName` no longer doubles as a promise of continuity across runs (the
// docs/spec.md claim this file's own header used to restate, that a team
// migrating in "keeps its existing Allure history/retry links intact", is
// withdrawn — see src/report/allure/map-
// scenario.ts's own header for why a step has no identity that survives a
// run at all, and why trying to fake one would only misconnect quietly).
// `buildFullName` stays a plain, readable identifier
// (`{project}:{featurePath}#{scenario}#{step text}`); the run/scenario/step-
// scoped values that deliberately keep two runs' own tests from linking live
// in `mapStep`'s own `identityParameters` instead, never mixed into this
// string.
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
 * there is no project name. emitter.ts's own caller passes `${pickle.name}#
 * ${step name}` as `name` (the
 * `{project}:{featurePath}#{scenario}#{step text}` shape) — one call per
 * step's own test now, not one per scenario. */
export function buildFullName(projectName: string | null, posixPath: string, name: string): string {
  return projectName === null ? `${posixPath}#${name}` : `${projectName}:${posixPath}#${name}`;
}
