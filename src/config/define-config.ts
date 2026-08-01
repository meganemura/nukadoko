import type { NukadokoConfigInput } from "./schema.js";

// Responsibility: the `defineConfig` identity helper (same convention as
// Vite/Vitest's `defineConfig`) — it exists purely to give a config author's
// object literal a type, nothing else. It does not validate: validation
// needs the config file's own path for a useful ConfigError, which this
// function does not have (it only sees the object literal, not where it
// came from) — that happens in load.ts once the file has been imported.
export function defineConfig(config: NukadokoConfigInput): NukadokoConfigInput {
  return config;
}
