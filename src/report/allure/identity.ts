import { readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the two disk-touching pieces of "history identity"
// (m3b-allure-emitter task spec, decision 5) small enough to isolate on
// their own — resolving the host project's own package.json `name` (or
// `null` when there isn't one), and assembling the `fullName` string the
// official cucumberjs Allure adapter's own convention uses, so a team
// migrating in keeps its existing Allure history/retry links intact.
//
// Deliberately does NOT compute `testCaseId` (the md5 of a *template*-name
// variant of this same fullName): that needs allure-js-commons' own
// `getTestResultTestCaseId` (never reimplement its md5 — this task's spec,
// code conventions), and map-scenario.ts (the module that resolves the
// Scenario Outline template name this needs) must stay free of any
// allure-js import of its own, so it cannot call that function either.
// emitter.ts is the one layer that already imports allure-js-commons for
// its own reasons; it calls `buildFullName` here a second time (with the
// template name in place of the pickle's own name) and feeds the result to
// `getTestResultTestCaseId` itself.

/** `null` when `<rootDir>/package.json` doesn't exist, isn't readable,
 * isn't valid JSON, or has no string `name` — every one of those collapses
 * to "no project name" the same way (this task's spec, decision 5:
 * unreadable or absent both collapse to null), since a caller building
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
 * `fullName`/`posixPath` (this task's spec, decision 5) require, regardless
 * of which separator the host OS's own `path.relative` produced. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/** `${projectName}:${posixPath}#${name}`, or `${posixPath}#${name}` when
 * there is no project name — the exact formula this task's spec, decision 5
 * pins. Shared by both the real `fullName` (built from the pickle's own
 * name) and the template variant emitter.ts builds for `testCaseId` (built
 * from the Scenario's own unexpanded name): same shape, different `name`
 * argument. */
export function buildFullName(projectName: string | null, posixPath: string, name: string): string {
  return projectName === null ? `${posixPath}#${name}` : `${projectName}:${posixPath}#${name}`;
}
