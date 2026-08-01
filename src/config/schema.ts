import { z } from "zod";

// Responsibility: the validated shape of nukadoko.config.ts's default
// export, per docs/spec.md's config section (featuresDir, baseURL, envFiles,
// environments, stateDir, browser, secrets). `.strict()` is what makes an
// unknown key an error instead of a silent no-op. `environments`/`browser`
// are accepted but left loosely typed here: their concrete shape is out of
// this slice's scope, and a config author setting them shouldn't be told the
// key itself is invalid before that shape is designed. `secrets` is *not*
// given the same loose treatment (m1-secrets task spec, scope item 2): its
// one field is small and fully designed by docs/spec.md today, so it is
// typed exactly.
export const configSchema = z
  .object({
    featuresDir: z.string().default("features"),
    stateDir: z.string().default(".nukadoko"),
    baseURL: z.string().optional(),
    envFiles: z.array(z.string()).optional(),
    environments: z.record(z.string(), z.unknown()).optional(),
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
