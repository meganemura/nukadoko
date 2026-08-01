import { z } from "zod";

// Responsibility: the validated shape of nukadoko.config.ts's default
// export, per docs/spec.md's config section (featuresDir, baseURL, envFiles,
// environments, stateDir, browser). `.strict()` is what makes an unknown key
// an error instead of a silent no-op. `environments`/`browser` are accepted
// but left loosely typed here: their concrete shape is out of this slice's
// scope, and a config author setting them shouldn't be told the key itself
// is invalid before that shape is designed.
export const configSchema = z
  .object({
    featuresDir: z.string().default("features"),
    stateDir: z.string().default(".nukadoko"),
    baseURL: z.string().optional(),
    envFiles: z.array(z.string()).optional(),
    environments: z.record(z.string(), z.unknown()).optional(),
    browser: z.unknown().optional(),
  })
  .strict();

/** The resolved config: defaults already applied. */
export type NukadokoConfig = z.infer<typeof configSchema>;

/** What `defineConfig` accepts: defaults not yet applied. */
export type NukadokoConfigInput = z.input<typeof configSchema>;
