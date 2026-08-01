import { z } from "zod";

// Responsibility: the validated shape of nukadoko.config.ts's default
// export, per docs/spec.md's config section (featuresDir, baseURL, envFiles,
// environments, stateDir, browser, secrets). `.strict()` is what makes an
// unknown key an error instead of a silent no-op. `environments` is now
// typed exactly (m1-environments task spec, decision 1): baseURL/envFiles
// per environment layer on top of the top-level values (resolution lives in
// src/environment/resolve-environment.ts, not here), `policy: "read-only"`
// and `version` exist only per-environment. `browser` stays loosely typed:
// its concrete shape is out of this slice's scope, and a config author
// setting it shouldn't be told the key itself is invalid before that shape
// is designed. `secrets` is *not* given the same loose treatment (m1-secrets
// task spec, scope item 2): its one field is small and fully designed by
// docs/spec.md today, so it is typed exactly.

// Same rule and reason as session names (src/session/name.ts): a name is
// used directly as a sessions/<env>/ directory segment, so anything outside
// this set — most importantly `.`/`/` — could escape that directory.
const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9_-]+$/;

/** One named deployment target (docs/spec.md "Sessions, environments,
 * secrets"). `version` is a function rather than a URL+jsonPath DSL:
 * nukadoko.config.ts is already executable TypeScript (loaded via tsx's
 * tsImport), so a config author can call HTTP or exec directly instead of
 * learning a bespoke schema for the same thing (this task's spec, decision
 * 1). zod has no schema shape for "a function with this signature", so
 * `z.custom` with a `typeof` check stands in here; the probe's actual return
 * value is only checked when it runs (src/environment/probe-version.ts). */
const environmentConfigSchema = z
  .object({
    baseURL: z.string().optional(),
    envFiles: z.array(z.string()).optional(),
    policy: z.literal("read-only").optional(),
    version: z
      .custom<() => string | Promise<string>>((value) => typeof value === "function", {
        message: "must be a function returning string | Promise<string>",
      })
      .optional(),
  })
  .strict();

/** One resolved `environments.<name>` entry, defaults not yet layered onto
 * the top-level config (that layering is resolve-environment.ts's job). */
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

export const configSchema = z
  .object({
    featuresDir: z.string().default("features"),
    stateDir: z.string().default(".nukadoko"),
    baseURL: z.string().optional(),
    envFiles: z.array(z.string()).optional(),
    environments: z
      .record(z.string().regex(ENVIRONMENT_NAME_PATTERN), environmentConfigSchema)
      .optional(),
    browser: z.unknown().optional(),
    /** Individual secret-source keys to demote to plain (never redacted).
     * Default `{ public: [] }`: nothing is public unless named. There is no
     * promotion counterpart — a tracked file's value is definitionally not a
     * secret (docs/spec.md "Secrets"), so making one a secret would need a
     * different mechanism than this one, out of scope here. */
    secrets: z
      .object({ public: z.array(z.string()).default([]) })
      .strict()
      .default({ public: [] }),
  })
  .strict();

/** The resolved config: defaults already applied. */
export type NukadokoConfig = z.infer<typeof configSchema>;

/** What `defineConfig` accepts: defaults not yet applied. */
export type NukadokoConfigInput = z.input<typeof configSchema>;
