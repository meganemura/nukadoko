import { z } from "zod";

// Responsibility: the validated shape of nukadoko.program.ts's default
// export (docs/spec.md "Program"): how nukadoko builds, prepares, starts,
// or reaches the program under test, the environment its processes get,
// and the named environments that override any of it. Boundary: shape
// only. Layering an environment over the top level is
// src/environment/resolve-environment.ts's job, and running a recipe is
// src/program/world.ts's.
//
// The program lives in a file of its own, apart from nukadoko.config.ts,
// because the config holds the criteria (features, steps, fixtures) and a
// run compares criteria across commits: with the recipe in the config, a
// change to how the program builds counted as a change to every criterion,
// and a run that read an older tree's config found no recipe at all.

// Same character set as a config name that is written on the command line
// and into every record (`--env <name>`, a world's directory).
const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9_-]+$/;

/** A command: an argv array, or a string split on whitespace. Neither goes
 * through a shell, so what runs does not depend on the host's shell; a
 * project that needs one writes `["sh", "-c", "..."]`. */
export type Command = string | readonly string[];

/** A command split into its words: an array as written, a string on
 * whitespace alone. A quoting rule would need a shell-words parser, which
 * is a dependency, and a shell would make what runs depend on the host.
 * Pure. */
export function commandWords(command: Command): string[] {
  return typeof command === "string" ? command.split(/\s+/).filter((word) => word !== "") : [...command];
}

const commandSchema = z
  .union([z.string(), z.array(z.string())])
  .refine((command) => (commandWords(command)[0] ?? "") !== "", { message: "must name a program to run" });

/** What a `url` function and the placeholders know before the program is
 * reached. */
export interface ProgramWorldPlace {
  /** The environment this world runs: `default` without `--env`. */
  readonly name: string;
  /** The root of the tree the program is built from. */
  readonly root: string;
  /** The world's own directory, for its state: `.nukadoko/runs/<run_id>/worlds/<name>/`. */
  readonly dir: string;
}

/** The world `setup` receives, once its program answers. */
export interface ProgramWorld extends ProgramWorldPlace {
  /** The world's base URL, `undefined` for a world with neither `serve` nor `url`. */
  readonly url: string | undefined;
  /** The port nukadoko gave `serve`, `undefined` without `serve`. */
  readonly port: number | undefined;
  /** `env` with its placeholders filled: what the program's processes and the steps' process get. */
  readonly env: Readonly<Record<string, string>>;
}

export type ProgramUrl = string | ((world: ProgramWorldPlace) => string | Promise<string>);
export type ProgramSetup = (world: ProgramWorld) => unknown;

/** `serve`'s defaults, applied when `serve` is written. */
export const DEFAULT_SERVE_TIMEOUT_MS = 60_000;

const serveSchema = z
  .object({
    command: commandSchema,
    /** `"auto"` takes a free port for each world. A number is checked
     * before the program starts: a port something already answers on would
     * send every request to a server nukadoko did not start. */
    port: z.union([z.literal("auto"), z.number().int().min(1).max(65_535)]).default("auto"),
    /** The path that answers 2xx once the program can take requests. */
    ready: z.string().startsWith("/", { message: 'must be a path starting with "/"' }).default("/"),
    timeout_ms: z.number().int().positive().default(DEFAULT_SERVE_TIMEOUT_MS),
  })
  .strict();

const functionSchema = <T>(message: string) => z.custom<T>((value) => typeof value === "function", { message });

const programFields = {
  /** Run once per tree per run, in the tree's root, before any world. */
  build: z.array(commandSchema).optional(),
  /** Run once per world, in the tree's root, with the world's env. */
  prepare: z.array(commandSchema).optional(),
  serve: serveSchema.optional(),
  /** A program nukadoko does not start: a remote server, a deployed preview. */
  url: z.union([z.string().min(1), functionSchema<(world: ProgramWorldPlace) => string | Promise<string>>("must be a URL or a function returning one")]).optional(),
  env: z.record(z.string(), z.string()).optional(),
  setup: functionSchema<ProgramSetup>("must be a function").optional(),
};

function serveOrUrl(value: { serve?: unknown; url?: unknown }, ctx: z.RefinementCtx): void {
  if (value.serve !== undefined && value.url !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "serve and url are two ways to reach the program: serve starts it, url names one nukadoko does not start. Keep one.",
      path: ["url"],
    });
  }
}

const environmentSchema = z
  .object({
    ...programFields,
    policy: z.literal("read-only").optional(),
    envFiles: z.array(z.string()).optional(),
    version: functionSchema<() => string | Promise<string>>("must be a function returning string | Promise<string>").optional(),
  })
  .strict()
  .superRefine(serveOrUrl);

export const programSchema = z
  .object({
    ...programFields,
    environments: z.record(z.string().regex(ENVIRONMENT_NAME_PATTERN), environmentSchema).optional(),
  })
  .strict()
  .superRefine(serveOrUrl);

/** The loaded program file, defaults applied. */
export type Program = z.infer<typeof programSchema>;
/** One `environments` entry, defaults applied. */
export type ProgramEnvironment = NonNullable<Program["environments"]>[string];
/** What `defineProgram` accepts. */
export type ProgramInput = z.input<typeof programSchema>;
/** `serve`, defaults applied. */
export type ProgramServe = z.infer<typeof serveSchema>;

/** How a world reaches its program: nukadoko starts it, it is already
 * somewhere, or there is no program to reach (a CLI tool whose steps run
 * commands, with a build to run first). One field, so a world cannot hold
 * both a server to start and a URL that ignores it. */
export type ProgramReach =
  | { readonly kind: "serve"; readonly serve: ProgramServe }
  | { readonly kind: "url"; readonly url: ProgramUrl }
  | { readonly kind: "none" };

/** One environment's program, its layer over the top level already
 * applied (src/environment/resolve-environment.ts). */
export interface ProgramRecipe {
  readonly build: readonly Command[];
  readonly prepare: readonly Command[];
  readonly reach: ProgramReach;
  readonly env: Readonly<Record<string, string>>;
  readonly setup: ProgramSetup | undefined;
}

function reachOf(fields: { serve?: ProgramServe | undefined; url?: ProgramUrl | undefined }): ProgramReach | undefined {
  if (fields.serve !== undefined) return { kind: "serve", serve: fields.serve };
  if (fields.url !== undefined) return { kind: "url", url: fields.url };
  return undefined;
}

/** `environment`'s fields over the top level's. A field the environment
 * writes replaces the top level's, except `env`, whose keys merge with the
 * environment's winning, so an environment that changes one variable does
 * not repeat the rest. `serve` and `url` are one choice: an environment that
 * writes either replaces the top level's. Pure. */
export function layerProgram(program: Program, environment: ProgramEnvironment | undefined): ProgramRecipe {
  return {
    build: environment?.build ?? program.build ?? [],
    prepare: environment?.prepare ?? program.prepare ?? [],
    reach: (environment === undefined ? undefined : reachOf(environment)) ?? reachOf(program) ?? { kind: "none" },
    env: { ...(program.env ?? {}), ...(environment?.env ?? {}) },
    setup: environment?.setup ?? program.setup,
  };
}
