import { readFileSync } from "node:fs";
import path from "node:path";

// Responsibility: `ctx.env` per docs/spec.md "Context API" — parse each
// configured envFile (KEY=VALUE text) and merge them in order, later files
// winning. No external dotenv dependency (none is added by this slice): the
// format handled here is deliberately modest — an optional `export ` prefix,
// `#`-comment lines, blank lines, and single/double-quoted values — per the
// task's own instruction not to gold-plate this. The process environment is
// never merged in: docs/spec.md's determinism goal means the same envFiles
// must produce the same ctx.env on any machine, whether or not it happens to
// have unrelated variables already set.
//
// `parseEnvFile` is exported so src/secrets/build-secret-set.ts can reuse the
// exact same KEY=VALUE parsing when it merges only the secret-source subset
// of envFiles into a SecretSet, without either module re-implementing the
// format or this module taking on any secrets-specific knowledge itself.

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    let value = withoutExport.slice(eq + 1).trim();
    const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Reads and merges `envFiles` (paths relative to `rootDir`) into a single
 * record, later files overriding earlier ones. A configured file that
 * doesn't exist on disk contributes nothing rather than failing the whole
 * run — a missing optional env file is not this function's call to make
 * fatal.
 */
export function loadEnvFiles(
  rootDir: string,
  envFiles: readonly string[],
): Record<string, string> {
  let merged: Record<string, string> = {};
  for (const relativePath of envFiles) {
    let content: string;
    try {
      content = readFileSync(path.join(rootDir, relativePath), "utf8");
    } catch {
      continue;
    }
    merged = { ...merged, ...parseEnvFile(content) };
  }
  return merged;
}
