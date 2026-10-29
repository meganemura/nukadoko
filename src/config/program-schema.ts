import { z } from "zod";
import { MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_REASON } from "../timer/max-delay.js";
import { BOOLEAN_TEXTS, CONDITION_NAME_PATTERN, CONDITION_VALUE_PATTERN, type Conditions } from "../condition/condition.js";
import { LIST_KINDS, type ListKind } from "../execution-events/lists.js";
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

/** How long a `build` or `prepare` command may run, a `setup` take, and
 * a `url` function take, unless the program file says otherwise. A phase
 * with no limit left a run waiting on a command that never ended, with
 * nothing on the terminal to say which. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
export const DEFAULT_URL_TIMEOUT_MS = 60_000;
/** How long a `lists` command may run: a list is read while the world
 * waits to run its first scenario. */
export const DEFAULT_LIST_TIMEOUT_MS = 60_000;

/** Every `timeout_ms` of the file: whole milliseconds, from 1 to the
 * longest delay a timer keeps (src/timer/max-delay.ts), refused when the
 * file is read rather than firing after 1 ms. */
const timeoutSchema = z
  .number()
  .int("must be a whole number of milliseconds")
  .min(1, "must be at least 1 ms")
  .max(MAX_TIMER_DELAY_MS, `must be ${MAX_TIMER_DELAY_REASON}`);

/** A `build` or `prepare` entry: a command, or a command with a
 * `timeout_ms` of its own. */
const stepCommandSchema = z.union([commandSchema, z.object({ command: commandSchema, timeout_ms: timeoutSchema.optional() }).strict()]);

/** A command with its limit, as a world runs it. */
export interface TimedCommand {
  readonly command: Command;
  readonly timeout_ms: number;
}

function timedCommand(entry: z.infer<typeof stepCommandSchema>, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): TimedCommand {
  if (typeof entry === "string" || Array.isArray(entry)) return { command: entry, timeout_ms: timeoutMs };
  return { command: entry.command, timeout_ms: entry.timeout_ms ?? timeoutMs };
}

/** `lists`: one command per kind of list the program prints
 * (src/execution-events/lists.ts), each a `build` entry's shape. */
const listsSchema = z
  .object({ routes: stepCommandSchema.optional(), flags: stepCommandSchema.optional() } satisfies Record<ListKind, unknown>)
  .strict();

/** A list a world reads, with its command and limit. */
export interface ProgramList extends TimedCommand {
  readonly kind: ListKind;
}

/** What a `url` function knows before the program is reached. */
export interface ProgramWorldPlace {
  /** The environment this world runs: `default` without `--env`. */
  readonly name: string;
  /** The root of the tree the program is built from. */
  readonly root: string;
  /** The world's own directory, for its state: `.nukadoko/runs/<run_id>/worlds/<name>/`. */
  readonly dir: string;
  /** Aborted when nukadoko abandons the function: at its `timeout_ms`, or
   * when a signal stops the start. nukadoko cannot stop a function from
   * outside, so one that does not honour this signal goes on running. */
  readonly signal: AbortSignal;
  /** Whose code the world runs: `"base"` for the base world of `nuka run
   * --base`, built from the ref, and `"head"` for every other world. A
   * `url` function that has no URL for the base gives nothing back, and
   * the base world then runs no cell (docs/spec.md "Verdicts"). */
  readonly tree: "head" | "base";
}

/** The world `setup` receives, once its program answers. */
export interface ProgramWorld extends ProgramWorldPlace {
  /** The world's base URL, `undefined` for a world with neither `serve` nor `url`. */
  readonly url: string | undefined;
  /** The world's port, the value of `{port}`: the one nukadoko gave
   * `serve`, or the port of `url` (written, or 443 for `https:` and 80 for
   * `http:`); `undefined` for a world with neither. */
  readonly port: number | undefined;
  /** `env` with its placeholders filled: what the program's processes and the steps' process get. */
  readonly env: Readonly<Record<string, string>>;
}

/** What a `url` function gives back: a URL, or nothing, which only a base
 * world may be given. */
export type ProgramUrlAnswer = string | undefined | null;
export type ProgramUrl = string | ((world: ProgramWorldPlace) => ProgramUrlAnswer | Promise<ProgramUrlAnswer>);
export type ProgramSetup = (world: ProgramWorld) => unknown;

const HTTP_URL = 'must be an http: or https: URL, such as "http://localhost:3000"';

/** Why `url` cannot be a world's URL, or `undefined` when it can be. Only
 * an `http:` or `https:` URL is one: a request to anything else is never
 * a request to the world, so nothing would carry a `traceparent` and no
 * step would say why. A user or a password in it is refused too: `fetch`
 * refuses such a URL, and every record that names the world's URL would
 * show the password. The reason never quotes the URL, for that password.
 * Pure. */
export function programUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return HTTP_URL;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return HTTP_URL;
  if (parsed.username !== "" || parsed.password !== "") {
    return "must not hold a user or a password: fetch refuses such a URL, and every record names the world's URL; a step sends credentials itself, from an env file";
  }
  return undefined;
}

/** The port a request to `url` goes to: the one it writes, or its
 * scheme's, 443 for `https:` and 80 for `http:`. `url` is one
 * `programUrlProblem` accepts. Pure. */
export function urlPort(url: string): number {
  const parsed = new URL(url);
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

// Any origin serves as the world's here: `ready` is checked before the
// world has a port.
const SOME_WORLD = new URL("http://localhost:1");

/** Why `ready` cannot be the path nukadoko polls, or `undefined` when it
 * can be. It has to stay on the world's server once resolved against the
 * world's URL: `//example.com/up`, or `/\example.com/up`, whose
 * backslash a URL parser reads as a slash, would send the ready check to
 * another host, which could answer for a program that never started.
 * Pure. */
export function readyPathProblem(ready: string): string | undefined {
  if (!ready.startsWith("/")) return 'must be a path starting with "/"';
  let resolved: URL;
  try {
    resolved = new URL(ready, SOME_WORLD);
  } catch {
    return 'must be a path starting with "/"';
  }
  if (resolved.origin !== SOME_WORLD.origin) {
    return 'must be a path on the world\'s own server, starting with one "/": a second "/" or a "\\" after it names another host';
  }
  return undefined;
}

/** A zod refinement that adds `problem`'s reason as the issue. */
function refusedBy(problem: (value: string) => string | undefined) {
  return (value: string, ctx: z.RefinementCtx): void => {
    const reason = problem(value);
    if (reason !== undefined) ctx.addIssue({ code: "custom", message: reason });
  };
}

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
    ready: z.string().superRefine(refusedBy(readyPathProblem)).default("/"),
    timeout_ms: timeoutSchema.default(DEFAULT_SERVE_TIMEOUT_MS),
  })
  .strict();

const functionSchema = <T>(message: string) => z.custom<T>((value) => typeof value === "function", { message });

const urlFunctionSchema = functionSchema<(world: ProgramWorldPlace) => ProgramUrlAnswer | Promise<ProgramUrlAnswer>>("must be a URL or a function returning one");
const setupFunctionSchema = functionSchema<ProgramSetup>("must be a function");

const programFields = {
  /** Run once per tree per run, in the tree's root, before any world. */
  build: z.array(stepCommandSchema).optional(),
  /** Run once per world, in the tree's root, with the world's env. */
  prepare: z.array(stepCommandSchema).optional(),
  serve: serveSchema.optional(),
  /** A program nukadoko does not start: a remote server, a deployed
   * preview. A function may take `timeout_ms` beside it as `resolve`. */
  url: z
    .union([
      z.string().superRefine(refusedBy(programUrlProblem)),
      urlFunctionSchema,
      z.object({ resolve: urlFunctionSchema, timeout_ms: timeoutSchema.optional() }).strict(),
    ])
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Run once per served world with an events file, after `setup`, with
   * the world's env: each prints the program's places of one kind
   * (docs/spec.md "Lists"). */
  lists: listsSchema.optional(),
  /** A function, or one with a `timeout_ms` of its own as `run`. */
  setup: z.union([setupFunctionSchema, z.object({ run: setupFunctionSchema, timeout_ms: timeoutSchema.optional() }).strict()]).optional(),
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

/** What an environment sets up, as facts a scenario's `@with:` and
 * `@without:` tags name (src/condition/condition.ts). Each value is one
 * a tag reads one way: a boolean, or a string `@with:<name>=<value>` can
 * name, which holds no whitespace and no `@` (Gherkin splits a tag at
 * either). The strings "true" and "false" are refused, not read: a string
 * meets `@with:<name>`, so "false" would read as on, and the boolean is
 * what the author meant. */
const conditionValueSchema = z.union([
  z.boolean(),
  z
    .string()
    .regex(CONDITION_VALUE_PATTERN, { message: "must be true, false, or a value with no whitespace and no \"@\", as @with:<name>=<value> names it" })
    .refine((value) => !BOOLEAN_TEXTS.has(value), {
      message: "is a boolean written as a string, which @with:<name> reads as on whatever it says: write the boolean, without quotes",
    }),
]);

const conditionsSchema = z
  .record(z.string(), conditionValueSchema)
  .superRefine((conditions, ctx) => {
    // A key refused by the record's own key schema reads "Invalid key in
    // record", which names no rule, so the name is checked here instead.
    for (const name of Object.keys(conditions)) {
      if (!CONDITION_NAME_PATTERN.test(name)) {
        ctx.addIssue({ code: "custom", path: [name], message: 'must be a condition name of letters, digits, "_", ".", or "-", as @with:<name> names it' });
      }
    }
  });

const environmentSchema = z
  .object({
    ...programFields,
    conditions: conditionsSchema.optional(),
    policy: z.literal("read-only").optional(),
    envFiles: z.array(z.string()).optional(),
    version: functionSchema<() => string | Promise<string>>("must be a function returning string | Promise<string>").optional(),
  })
  .strict()
  .superRefine(serveOrUrl);

/** `defaultEnvironments` names environments of this file, each once.
 * `default` is the top level's name wherever an environment is named
 * (`--env default`), so it may be named whether or not `environments`
 * defines it. */
function defaultEnvironmentsNamed(value: { defaultEnvironments?: readonly string[] | undefined; environments?: Record<string, unknown> | undefined }, ctx: z.RefinementCtx): void {
  const named = value.defaultEnvironments;
  if (named === undefined) return;
  const defined = Object.keys(value.environments ?? {});
  named.forEach((name, index) => {
    if (name !== "default" && !defined.includes(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultEnvironments", index],
        message: `names "${name}", which is neither default nor an environment of this file (${defined.length === 0 ? "it defines none" : `it defines ${defined.map((entry) => `"${entry}"`).join(", ")}`})`,
      });
    }
    if (named.indexOf(name) !== index) {
      ctx.addIssue({ code: "custom", path: ["defaultEnvironments", index], message: `names "${name}" more than once, which would run every scenario twice under one name` });
    }
  });
}

export const programSchema = z
  .object({
    ...programFields,
    environments: z.record(z.string().regex(ENVIRONMENT_NAME_PATTERN), environmentSchema).optional(),
    /** The environments a run without `--env` starts, in this order. */
    defaultEnvironments: z.array(z.string()).min(1, { message: "must name at least one environment; leave it out for the default selection" }).optional(),
  })
  .strict()
  .superRefine(serveOrUrl)
  .superRefine(defaultEnvironmentsNamed);

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
  | { readonly kind: "url"; readonly url: ProgramUrl; readonly timeout_ms: number }
  | { readonly kind: "none" };

/** One environment's program, its layer over the top level already
 * applied (src/environment/resolve-environment.ts), each limit filled. */
export interface ProgramRecipe {
  readonly build: readonly TimedCommand[];
  readonly prepare: readonly TimedCommand[];
  readonly reach: ProgramReach;
  /** One per kind `lists` names, in LIST_KINDS order. */
  readonly lists: readonly ProgramList[];
  readonly env: Readonly<Record<string, string>>;
  readonly setup: { readonly run: ProgramSetup; readonly timeout_ms: number } | undefined;
  /** The environment's `conditions`, which fill `{condition.<name>}`
   * (src/program/placeholders.ts); `undefined` when it declares none. */
  readonly conditions: Conditions | undefined;
}

type UrlField = NonNullable<Program["url"]>;
type SetupField = NonNullable<Program["setup"]>;

function reachOf(fields: { serve?: ProgramServe | undefined; url?: UrlField | undefined }): ProgramReach | undefined {
  if (fields.serve !== undefined) return { kind: "serve", serve: fields.serve };
  if (fields.url === undefined) return undefined;
  if (typeof fields.url === "string" || typeof fields.url === "function") return { kind: "url", url: fields.url, timeout_ms: DEFAULT_URL_TIMEOUT_MS };
  return { kind: "url", url: fields.url.resolve, timeout_ms: fields.url.timeout_ms ?? DEFAULT_URL_TIMEOUT_MS };
}

function listsOf(lists: Program["lists"]): readonly ProgramList[] {
  return LIST_KINDS.flatMap((kind) => {
    const entry = lists?.[kind];
    return entry === undefined ? [] : [{ kind, ...timedCommand(entry, DEFAULT_LIST_TIMEOUT_MS) }];
  });
}

function setupOf(setup: SetupField | undefined): ProgramRecipe["setup"] {
  if (setup === undefined) return undefined;
  if (typeof setup === "function") return { run: setup, timeout_ms: DEFAULT_SETUP_TIMEOUT_MS };
  return { run: setup.run, timeout_ms: setup.timeout_ms ?? DEFAULT_SETUP_TIMEOUT_MS };
}

/** `environment`'s fields over the top level's. A field the environment
 * writes replaces the top level's, except `env`, whose keys merge with the
 * environment's winning, so an environment that changes one variable does
 * not repeat the rest. `serve` and `url` are one choice: an environment that
 * writes either replaces the top level's. An environment's `lists`
 * replaces the top level's whole, so `lists: {}` reads none there. Pure. */
export function layerProgram(program: Program, environment: ProgramEnvironment | undefined): ProgramRecipe {
  return {
    build: (environment?.build ?? program.build ?? []).map((entry) => timedCommand(entry)),
    prepare: (environment?.prepare ?? program.prepare ?? []).map((entry) => timedCommand(entry)),
    reach: (environment === undefined ? undefined : reachOf(environment)) ?? reachOf(program) ?? { kind: "none" },
    lists: listsOf(environment?.lists ?? program.lists),
    env: { ...(program.env ?? {}), ...(environment?.env ?? {}) },
    setup: setupOf(environment?.setup ?? program.setup),
    conditions: environment?.conditions,
  };
}
