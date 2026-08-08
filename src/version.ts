import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Responsibility: the one place that reads nukadoko's own installed
// package.json `version` at runtime — for `nuka --version` (src/cli/run-
// cli.ts, wiring yargs' `.version()`) and for the cucumber-messages `Meta.
// implementation.version` field (src/report/messages/emitter.ts's
// buildMeta()). Both need *this* package's own version, never the host
// project's: that's a different, already-separate concern (src/report/
// allure/identity.ts's resolveProjectName reads `rootDir`'s own
// package.json — the project under test — and stays that way; this module
// is not a generalization of it).
//
// The bug this module exists to fix: `nuka --version` used
// to fall through to yargs' own default version resolution, which walks up
// from `process.cwd()` and reads whichever project's package.json happens
// to be running the CLI — not nukadoko's own. `process.cwd()` is exactly
// what must not be used here; the only path guaranteed to point at *this*
// package's own files, regardless of which project installed it or where
// the process was launched from, is one derived from where this file
// itself was loaded from: `import.meta.url` (same principle src/cli/
// skill.ts's own packageRoot() documents at its own top).
//
// tsconfig.build.json mirrors `src/` onto `dist/` one-for-one, so this
// file lives at `<root>/src/version.ts` pre-build and `<root>/dist/
// version.js` post-build — in both cases *one* directory below `<root>`.
// That is one level shallower than skill.ts's own packageRoot(): skill.ts
// sits inside `src/cli/` (two directories below root) and so walks up
// two; this file sits directly in `src/` (one directory below root) and so
// walks up only one. Same mirroring principle, different depth because
// this file's own location is different. Walking up one directory from
// this file's own URL therefore lands on the package root whether the
// process started via `npx tsx src/cli.ts` or `node dist/cli.js`.
//
// Reads via `readFileSync` + `JSON.parse`, not `createRequire(import.meta.
// url)("../package.json")`: this codebase already reads package.json this
// way elsewhere (src/report/allure/identity.ts's resolveProjectName), so
// this stays consistent with it rather than introducing a second technique
// that needs its own CommonJS-interop reasoning. An ESM JSON import
// assertion (`import pkg from "../package.json" with { type: "json" }`)
// was considered and rejected: the assertion syntax itself has moved across
// Node's own minor versions, and this module's whole point is to keep
// working across every Node version this package's `engines.node` allows.

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

/**
 * nukadoko's own `package.json` `version`. Throws when the package root has
 * no readable package.json, or one with no string `version` field: that
 * state means the published tarball is missing its own package.json (see
 * package.json's `files` list) or has a malformed one — a packaging bug,
 * not a project misconfiguration (same framing src/cli/skill.ts's own
 * runSkillPath uses for its "(a packaging bug, not a project issue)"
 * message). It is not swallowed into a guessed fallback string here; each
 * caller decides how to surface the failure (src/cli/run-cli.ts fails the
 * whole invocation before parsing any command; src/report/messages/
 * emitter.ts's buildMeta() is already called inside begin()'s own
 * try/catch, so this module doesn't need a second one).
 */
export function readOwnVersion(): string {
  const pkgPath = path.join(packageRoot(), "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch (error) {
    throw new Error(
      `nukadoko: could not read its own package.json at ${pkgPath} (a packaging bug, not a project issue): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  const version =
    parsed !== null && typeof parsed === "object" && "version" in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;

  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `nukadoko: its own package.json at ${pkgPath} has no string "version" field (a packaging bug, not a project issue)`,
    );
  }

  return version;
}
