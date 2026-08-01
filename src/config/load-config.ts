import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { z } from "zod";
import { ConfigError } from "./errors.js";
import { configSchema, type NukadokoConfig } from "./schema.js";

const CONFIG_FILE_NAME = "nukadoko.config.ts";

// Responsibility: find nukadoko.config.ts under a project root, load it at
// run time (it is TypeScript, not something Node can import unassisted —
// hence tsx's tsImport, per the spec), and turn its default export into a
// fully-defaulted, validated NukadokoConfig. Applying defaults through the
// same schema used for validation (rather than a second hard-coded literal)
// keeps "file absent" and "file present but empty" behave identically.

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        return `unknown key(s): ${issue.keys.join(", ")}`;
      }
      const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${key}: ${issue.message}`;
    })
    .join("; ");
}

export async function loadConfig(rootDir: string): Promise<NukadokoConfig> {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);

  let raw: unknown = {};
  if (existsSync(configPath)) {
    const mod: { default?: unknown } = await tsImport(
      pathToFileURL(configPath).href,
      import.meta.url,
    );
    raw = mod.default ?? {};
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${configPath}: ${formatIssues(result.error.issues)}`,
      configPath,
    );
  }
  return result.data;
}
