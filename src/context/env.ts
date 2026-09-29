import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../env/parse-env-file.js";

export { parseEnvFile };

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
// The KEY=VALUE parser itself is src/env/parse-env-file.ts. Re-exported
// here so a caller that already loads `ctx.env` can parse one file with
// the same function. Secrets imports the parser from that module directly:
// importing it from here would make secrets depend on context.

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
