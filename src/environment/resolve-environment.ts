import type { NukadokoConfig } from "../config/schema.js";
import { UnknownEnvironmentError } from "./errors.js";

// Responsibility: turn a `--env` name plus the loaded config into the
// *effective* settings one `do` run actually uses, and never anything
// else's job (cli/do.ts wires the result into session
// paths, the read-only check, the version probe, and ctx.baseURL/envFiles;
// it never re-derives any of this layering itself).
//
// Layering rule: effective baseURL = env.baseURL ?? top-level
// baseURL; effective envFiles = [...top-level envFiles, ...env.envFiles]
// (append, later files winning when merged by context/env.ts — the same
// "common + per-environment override" shape as dotenv's own convention).
// `policy`/`version` exist only per-environment; there is no top-level
// fallback for either.
//
// Unknown-name handling depends on whether `--env` was given
// explicitly: an explicit name with no matching `environments` entry is a
// setup failure (`UnknownEnvironmentError`), but the implicit "default" (no
// `--env` at all) is *not* required to have a matching entry — it just
// resolves with no per-environment overrides. This is not a special case for
// the string "default"; it is a special case for "the name was never asked
// for", which the CLI layer signals via `explicit`.

export const DEFAULT_ENVIRONMENT_NAME = "default";

export interface ResolvedEnvironment {
  readonly name: string;
  readonly baseURL: string | undefined;
  readonly envFiles: readonly string[];
  readonly policy: "read-only" | undefined;
  readonly version: (() => string | Promise<string>) | undefined;
}

export function resolveEnvironment(
  config: NukadokoConfig,
  name: string,
  explicit: boolean,
): ResolvedEnvironment {
  const envConfig = config.environments?.[name];
  if (envConfig === undefined && explicit) {
    throw new UnknownEnvironmentError(name);
  }

  return {
    name,
    baseURL: envConfig?.baseURL ?? config.baseURL,
    envFiles: [...(config.envFiles ?? []), ...(envConfig?.envFiles ?? [])],
    policy: envConfig?.policy,
    version: envConfig?.version,
  };
}
