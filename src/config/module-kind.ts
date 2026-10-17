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

/** package.json's own "type" field: `undefined` when it has none, and
 * `null` when there is no package.json or nothing here can read one. */
function packageType(rootDir: string): unknown {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return (parsed as { type?: unknown }).type;
}

export function isCommonJsProject(rootDir: string): boolean {
  const type = packageType(rootDir);
  return type !== null && type !== "module";
}

// Narrower than isCommonJsProject, for the import-failure sentence below.
// With no "type" at all, Node reparses a .ts file written as an ES module
// and loads it with a warning, so a failure there has some other cause, and
// naming the module kind would be a guess. Only "type": "commonjs" makes
// Node refuse the ES module syntax outright.
export function refusesEsmTs(rootDir: string): boolean {
  return packageType(rootDir) === "commonjs";
}

// Every place that reports a step file's import failure (`nuka check`'s
// `step-file-import-failed`, and the stderr tail `nuka steps`/`nuka
// describe` print via `formatImportFailuresStderr`) hits the same one cause
// in a project whose package.json says "type": "commonjs": a .ts step file,
// which Node treats as CommonJS there, fails to import as the ES module
// nukadoko loads it as.
// Node's own error names a syntax error or a missing export in a file that
// is fine as an ES module, which reads like a bug in the file rather than
// a module-kind mismatch. This is the one sentence that names the real cause,
// factored out so every caller appends the identical wording rather than
// each writing its own paraphrase.
//
// Takes refusesEsmTs's answer as an already-computed boolean, not
// `rootDir`, so a caller that reports many failures in one project (`nuka
// check`'s own loop over `importFailures`) reads package.json once,
// not once per failure. Returns "" (append nothing) unless both conditions
// hold: the project is "type": "commonjs", and the failed file is itself
// .ts. Any other project, or a failure on a file that isn't .ts, gets
// nothing appended. Saying more would guess at a failure this function did
// not recognize, and a guess is worse than no check.
//
// `loadConfig` appends this same sentence when the failed file is the
// config. That failure is not the "Cannot find module" above. The config's
// own import error, or a schema failure on the CommonJS interop wrapper,
// is what the caller already has, and this sentence is only the module-kind
// half.
export function cjsTsMismatchExplanation(refusesEsm: boolean, filePath: string): string {
  if (!refusesEsm || path.extname(filePath) !== ".ts") {
    return "";
  }
  return ` This project's package.json says "type": "commonjs", so Node reads .ts here as CommonJS; nukadoko is ESM-only, so rename this file to .mts.`;
}
