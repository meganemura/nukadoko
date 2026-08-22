import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the one fact `nuka init` (which config file name to
// write), `nuka scaffold` (which step-file extension to write), and `nuka
// check`/`nuka steps`/`nuka describe` (whether a failed .ts step file's own
// extension is the actual cause) all need: whether a project reads a plain
// .ts file as CommonJS. Kept in one place so no caller can disagree with
// another about a project already checked once.
//
// Node's own rule is package.json's nearest "type" field, and this mirrors
// it rather than inspecting anything else (a tsconfig "module" setting, a
// babel config): those affect a project's own build step, not how Node's
// loader treats a .ts file it is asked to import directly, which is the
// failure this repository's own CJS door exists to name.
//
// No package.json at all is answered as "not CommonJS", matching what
// `nuka init` already does without this module: it still writes
// nukadoko.config.ts, the same file a project that later adds
// `"type": "module"` would want anyway. A package.json that exists but
// fails to parse is answered the same way, on purpose: nothing here can
// tell CommonJS from a malformed file, and guessing CommonJS from a
// parse failure would tell an init or check finding to name a cause this
// module never actually confirmed.

export function isCommonJsProject(rootDir: string): boolean {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }

  return (parsed as { type?: unknown }).type !== "module";
}

// Every place that reports a step file's import failure (`nuka check`'s
// `step-file-import-failed`, and the stderr tail `nuka steps`/`nuka
// describe` print via `formatImportFailuresStderr`) hits the same one cause
// in a CommonJS project: a .ts step file, which Node treats as
// CommonJS there, fails to import before nukadoko's own ESM-only loader
// (tsx) can read it. Node's own error is a bare "Cannot find module
// '<path>?namespace=<uuid>'" naming the very file that does exist on disk,
// true only in the sense that the loader gave up before opening it, and
// misleading on its own, since it reads like a missing file rather than a
// module-kind mismatch. This is the one sentence that names the real cause,
// factored out so every caller appends the identical wording rather than
// each writing its own paraphrase.
//
// Takes the project's CommonJS-ness as an already-computed boolean, not
// `rootDir`, so a caller that reports many failures in one project (`nuka
// check`'s own loop over `importFailures`) calls `isCommonJsProject` once,
// not once per failure. Returns "" (append nothing) unless both conditions
// hold: the project is CommonJS, and the failed file is itself .ts. A
// project that isn't CommonJS, or a failure on a file that isn't .ts, gets
// nothing appended (CLAUDE.md: "a check that guesses is worse than no
// check").
export function cjsTsMismatchExplanation(isCjsProject: boolean, filePath: string): string {
  if (!isCjsProject || path.extname(filePath) !== ".ts") {
    return "";
  }
  return ` This project has no "type": "module" in package.json, so nukadoko reads .ts here as CommonJS; nukadoko is ESM-only, so rename this file to .mts.`;
}
