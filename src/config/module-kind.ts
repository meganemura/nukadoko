import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the one fact `nuka init` (which config file name to
// write) and `nuka check` (whether a failed .ts step file's own extension
// is the actual cause) both need: whether a project reads a plain .ts file
// as CommonJS. Kept in one place so the two callers can never disagree
// about a project already checked once.
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
