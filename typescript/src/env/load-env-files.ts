import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnvFile } from "./parse-env-file.js";

// Responsibility: the one read-parse-merge of configured env files.
// `ctx.env` (src/context/env.ts re-exports this function) and the secret
// set (src/secrets/build-secret-set.ts) both need it. A subset of the
// configured list is the same loop with a shorter path list, so the two
// callers share this function instead of each keeping a copy.
//
// A path that is not on disk (ENOENT) contributes nothing. A missing
// optional env file is not this function's call to make fatal: `nuka check`
// is what warns about it. Every other read error is thrown as
// `EnvFileUnreadableError`, whose `code` the CLI refuses with
// (`env-file-unreadable`). The message names the configured path and the
// errno, and every command that reads the env files refuses on it before
// any step runs. Swallowing EACCES or EISDIR used to look exactly
// like ENOENT, so the first requireEnv blamed the key for a file that was
// never read.
//
// The process environment is never merged in. docs/spec.md's determinism
// goal means the same envFiles must produce the same record on any machine.

/** A configured env file that is on disk and could not be read. `code` is
 * the refusal code, read by the CLI the way it reads any error's own code. */
export class EnvFileUnreadableError extends Error {
  readonly code = "env-file-unreadable";
  readonly relativePath: string;

  constructor(relativePath: string, detail: string, cause: unknown) {
    super(`env file "${relativePath}" could not be read: ${detail}`, { cause });
    this.name = "EnvFileUnreadableError";
    this.relativePath = relativePath;
  }
}

/**
 * Reads and merges `envFiles` (paths relative to `rootDir`) into a single
 * record, later files overriding earlier ones. A path that is not on disk
 * contributes nothing. Any other read error is thrown, naming the
 * configured path and the errno.
 */
export function loadEnvFiles(
  rootDir: string,
  envFiles: readonly string[],
): Record<string, string> {
  let merged: Record<string, string> = {};
  for (const relativePath of envFiles) {
    const content = readEnvFile(rootDir, relativePath);
    if (content === undefined) {
      continue;
    }
    merged = { ...merged, ...parseEnvFile(content) };
  }
  return merged;
}

/** `undefined` only for ENOENT. Every other failure throws. */
function readEnvFile(rootDir: string, relativePath: string): string | undefined {
  try {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return undefined;
    }
    const code = nodeErrorCode(error);
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    throw new EnvFileUnreadableError(relativePath, detail, error);
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
