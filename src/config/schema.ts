import type { APIRequest, BrowserContextOptions, LaunchOptions } from "playwright";
import { z } from "zod";
import type { ParameterTypeConfig as BindingParameterTypeConfig } from "../binding/parameter-type-config.js";
import type { FixtureDefinition } from "../step/fixture-types.js";

// Responsibility: the validated shape of nukadoko.config.ts's default
// export, per docs/spec.md's config section (featuresDir, envFiles,
// stateDir, browser, browserContext, requestContext, secrets,
// parameterTypes, worldParameters). `.strict()` is
// what makes an unknown key an error instead of a silent no-op. The config
// holds the criteria side only: how the program under test is built,
// started, or reached, and the named environments, are
// nukadoko.program.ts's (src/config/program-schema.ts). `browser` takes
// Playwright's own `LaunchOptions` type directly rather than a bespoke
// enumeration — see the field's own
// doc comment for why zod does not re-validate its shape. `secrets` is
// typed differently again: its one
// field is small and fully designed by docs/spec.md today, so it is typed
// exactly, for the opposite reason
// `browser` is not — there is no upstream type to defer to for it.
// `parameterTypes` is typed
// exactly for the same reason `secrets` is: docs/spec.md fully designs its
// one shape today, `{ name, regexp, transformer? }`. Registering it — and
// rejecting a name that collides with a built-in type or another entry in
// this same list — is src/binding/registry.ts's job, not this schema's; a
// zod schema only rejects shapes, not cross-entry relationships.

// A parameter type's own name, same character set as an environment name
// (src/config/program-schema.ts): it is not filesystem-derived here, but it is
// still the identifier a pattern's `{key:type}` and this list's collision
// check both key off of, so keeping it to an unambiguous, easy-to-diff
// character set costs nothing and rules out a name that would need
// escaping wherever it is printed (error messages, `nuka check --json`).
const PARAMETER_TYPE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** One `parameterTypes` entry (docs/spec.md config section): registers a
 * custom cucumber-expressions parameter type. `regexp` and `transformer` are
 * handed to `@cucumber/cucumber-expressions`' own `ParameterType` almost
 * verbatim (src/binding/registry.ts) — zod's job here is only to reject the
 * shapes that type couldn't possibly accept before anything tries to
 * construct it, not to re-describe its full contract. `z.custom` is what
 * stands in for "a RegExp or a string" and "a function": zod has no built-in
 * schema for either.
 * `transformer` is intentionally typed as accepting/returning `unknown` —
 * its return value is not statically checked: a custom type's captured
 * value skips check's capture-type-mismatch
 * comparison entirely, since `capture.type` for a custom type never equals
 * a built-in type name such as "int" or "word" (see src/check/binding-check.ts); the args
 * zod schema is the real, run-time contract for it (docs/spec.md: "the
 * transformer is coercion; the args schema remains the contract"). */
const parameterTypeConfigSchema = z
  .object({
    name: z.string().regex(PARAMETER_TYPE_NAME_PATTERN),
    regexp: z.custom<RegExp | string>((value) => value instanceof RegExp || typeof value === "string", {
      message: "must be a RegExp or a string",
    }),
    transformer: z
      .custom<(...match: string[]) => unknown>((value) => typeof value === "function", {
        message: "must be a function",
      })
      .optional(),
  })
  .strict();

/** One `parameterTypes[]` entry, defaults not applied (there is nothing to
 * default here beyond the list itself, see `configSchema` below). */
export type ParameterTypeConfig = z.infer<typeof parameterTypeConfigSchema>;

// The registry owns the name `ParameterTypeConfig` (src/binding/
// parameter-type-config.ts) and must not import this file to get it.
// This alias fails typecheck when the zod inference and that interface
// stop being the same shape.
type _ParameterTypeConfigMatchesBinding = [ParameterTypeConfig] extends [BindingParameterTypeConfig]
  ? [BindingParameterTypeConfig] extends [ParameterTypeConfig]
    ? true
    : never
  : never;
const _parameterTypeConfigMatchesBinding: _ParameterTypeConfigMatchesBinding = true;

/** `stepTimeout`'s default: twenty minutes. Not a guess about how long a
 * step should take, but a horizon past which a step that has not returned
 * is taken to be stuck. It is deliberately far above what steps actually
 * take: 800 step records sampled from a real browser suite ran a median of
 * 66ms, a 99th percentile of 10.7s, and a maximum of 14s, with none over
 * 30s. */
export const DEFAULT_STEP_TIMEOUT_MS = 1_200_000;
/** `retention.runs`'s default. 20 is a judgment, not a measurement: the
 * heaviest suite measured so far costs about 50 MB per run once trace
 * attachments are hard links rather than copies, so 20 runs is about 1 GB
 * for that suite and far less for a suite without a browser. Fewer than
 * that and the failure a person was chasing an hour ago is already gone on
 * a suite run every few minutes. */
const DEFAULT_RETENTION_RUNS = 20;
/** `retention.adHocDays`'s default: long enough that a `nuka do --use`
 * chain started one week and continued the next still resolves. */
const DEFAULT_RETENTION_AD_HOC_DAYS = 7;

/** `APIRequest.newContext`'s options (`requestContext` below) have no named
 * export from Playwright the way `BrowserContextOptions` does
 * (`browserContext` below) — `APIRequest.newContext`'s argument is declared
 * inline. Referencing it through `Parameters<>` rather than redefining it
 * here keeps the same "use Playwright's own type as-is" policy `browser` and
 * `browserContext` both follow (see their doc comments): only the name is
 * missing upstream, not the type itself. */
type RequestContextOptions = NonNullable<Parameters<APIRequest["newContext"]>[0]>;

// Same character set requirement as a parameter-type name
// (`PARAMETER_TYPE_NAME_PATTERN` above), but
// stricter still: a fixture name is destructured directly (`{ tenant }`,
// src/step/fixture-names.ts), so it must be a legal JS identifier, not just
// an unambiguous, easy-to-diff string — a leading digit or a hyphen would
// make the very destructuring pattern this key exists to be named by a
// syntax error.
const FIXTURE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isFixtureFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/** `config.fixtures.<name>`'s own shape (docs/spec.md "Fixtures") —
 * zod's job here stops at "is this a function, or a `[function, options]`
 * tuple, and is `options` itself well-formed" (the same shallow "is this an
 * object" contract `browser`/`browserContext`/`requestContext` above keep
 * for their own Playwright-deferred types); a fixture's own *dependency
 * names* (unknown name, default value, `...rest`, not destructured at all)
 * are not zod's concern — those are read from the function's own source
 * text and validated by src/fixture/validate-fixtures.ts, run over the
 * *resolved* config (loadConfig's own caller), the same split defineConfig/
 * loadConfig already keep for the rest of this file.
 *
 * `auto: true` is refused right here, at config-load time, with a message
 * naming *why* — the one option this schema
 * does treat as a hard, structural mistake rather than deferring to a later
 * check: accepting it would be the first claim this package would be
 * breaking about its own fixture support. nukadoko accepts the *shape* of a
 * Playwright fixture definition, never its "build whatever wasn't named"
 * behavior. The feature file names everything that ran, and an engine that
 * constructs a fixture nothing named would break that, so this package
 * never claims to be "Playwright fixture compatible". */
const fixtureDefinitionSchema: z.ZodType<FixtureDefinition, FixtureDefinition> = z
  .custom<FixtureDefinition>(
    (value) => isFixtureFunction(value) || (Array.isArray(value) && value.length === 2 && isFixtureFunction(value[0])),
    { message: "must be a function, or a [function, options] tuple (the same shape Playwright's own fixture definitions take)" },
  )
  .superRefine((value, ctx) => {
    if (isFixtureFunction(value)) {
      return; // Bare function: no options to validate.
    }
    const [, options] = value;
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      ctx.addIssue("fixture options (the tuple's second element) must be an object");
      return;
    }
    const obj = options as Record<string, unknown>;
    if ("auto" in obj) {
      ctx.addIssue(
        'fixture options cannot set "auto": nukadoko never builds a fixture that nothing named (docs/spec.md ' +
          '"the feature file names everything that ran"). This package accepts the same fixture *definition* ' +
          'shape Playwright does, but does not claim "Playwright fixture compatible" beyond that shape, and ' +
          '"auto" is exactly the claim it would be breaking',
      );
    }
    if (obj.scope !== undefined && obj.scope !== "scenario" && obj.scope !== "process") {
      ctx.addIssue(
        `fixture options.scope must be "scenario" or "process" (got ${JSON.stringify(obj.scope)}); "worker" does ` +
          'not exist: a nuka run --concurrency worker is a process, so "process" already names one worker',
      );
    }
    if (obj.timeout !== undefined && (typeof obj.timeout !== "number" || !(obj.timeout > 0))) {
      ctx.addIssue("fixture options.timeout must be a positive number of milliseconds");
    }
    const unknownKeys = Object.keys(obj).filter((key) => key !== "scope" && key !== "timeout" && key !== "auto");
    if (unknownKeys.length > 0) {
      ctx.addIssue(`unknown fixture option key(s): ${unknownKeys.join(", ")}`);
    }
  });

export const configSchema = z
  .object({
    featuresDir: z.string().default("features"),
    /** `featuresDir` is the set that runs with no argument (`nuka run`
     * and `nuka check` both default to it); `additionalFeatureDirs`
     * is a second, disjoint set that never runs on its own but still binds
     * vocabulary — a step's pattern is bound or unbound as a property of the
     * whole project, not just of what `nuka run` would execute today. This
     * is why an acceptance
     * feature — recommended to live outside `featuresDir` precisely so it is
     * never picked up as a regression (skills/nukadoko/SKILL.md) — belongs
     * here: it must never run unattended, but a static check that doesn't
     * see it will wrongly call the steps it uses unbound. `nuka check`
     * (no argument) reads both sets; `nuka run` (no argument)
     * reads only `featuresDir`, unchanged — this asymmetry is the field's
     * whole point, not an oversight. Default `[]`: nothing extra is scanned
     * unless named. */
    additionalFeatureDirs: z.array(z.string()).default([]),
    stateDir: z.string().default(".nukadoko"),
    /** Env files every environment loads; an environment in
     * nukadoko.program.ts appends its own (src/environment/
     * resolve-environment.ts). */
    envFiles: z.array(z.string()).optional(),
    // Default `[]`: registering nothing is the common case, and every
    // consumer (src/binding/registry.ts's factory) already treats "no custom
    // types" as its own no-op default, so this mirrors that rather than
    // making every call site handle `undefined` separately.
    parameterTypes: z.array(parameterTypeConfigSchema).default([]),
    /** The object a compat World's constructor receives as `parameters`,
     * which glue reads as `this.parameters`. cucumber-js takes the same
     * object from its configuration (`worldParameters`) or from
     * `--world-parameters`. This key is that object. There is no CLI flag
     * beside it: two ways to supply one object can disagree, and a migrated
     * suite's parameters are a fixed input of the project, which is what
     * config already is. Default `{}`: a suite that never set them keeps
     * seeing an empty object, the value the constructor passed before this
     * key existed. `z.record` rejects an array, a string, `null`, and a
     * class instance, so a value that is not a plain object fails at load
     * instead of arriving as a shape `this.parameters.baseUrl` cannot read. */
    worldParameters: z.record(z.string(), z.unknown()).default({}),
    /** User-defined fixtures (docs/spec.md "Fixtures") — layered
     * *after* the builtin set (`page`/`context`/`request`/... —
     * src/step/context.ts's `BUILTIN_FIXTURE_NAMES`), so a key here with the
     * same name as a builtin overrides it (src/fixture/graph.ts's own
     * layering rule). Default `{}`: no user fixtures unless named, the
     * same "nothing extra unless named" convention `parameterTypes` above
     * and `additionalFeatureDirs` below both already follow. */
    fixtures: z.record(z.string().regex(FIXTURE_NAME_PATTERN), fixtureDefinitionSchema).default({}),
    /** The default setup/teardown timeout every fixture instance gets
     * (milliseconds), overridable per fixture via that fixture's own
     * `options.timeout` — without a default,
     * a fixture that forgets to call `use(...)` would leave `nuka run`
     * hanging indefinitely instead of failing with a named cause
     * (src/fixture/lifecycle.ts's own `FixtureTimeoutError`). */
    fixtureTimeout: z.number().positive().default(60_000),
    /** Which Playwright browser engine `ctx.page()` launches —
     * deliberately a separate key from `browser` below, never a
     * field mixed into it: `LaunchOptions` (`browser`'s own type) has no key
     * that selects an engine at all, because Playwright picks one by which
     * of `chromium`/`firefox`/`webkit`'s own `launch` gets called, not by an
     * option passed to it. Putting an engine selector inside `browser` would
     * mean accepting a key `LaunchOptions` itself has no room for, which
     * would break that field's own "hand Playwright's type through exactly
     * as declared" contract (see its doc comment below). Default
     * `"chromium"`: a project that never sets this launches exactly what it
     * always has. Firefox and webkit each need their own binary installed
     * (`npx playwright install firefox`/`webkit`) — this schema only checks
     * that the *name* is one of the three Playwright ships; whether the
     * binary is actually present can only be learned by launching it, so
     * `nuka check` makes no claim about it (would be a guess, not a static
     * fact) and a missing binary surfaces as Playwright's own error at
     * launch time, unmodified. */
    browserType: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
    /** Playwright's own `LaunchOptions` type, taken as-is: coupling to
     * Playwright is an accepted design
     * choice (docs/spec.md "Out of scope"), so there is no vocabulary of our
     * own to translate its option names through, and no need to widen this
     * schema every time Playwright adds one. zod here checks only "is this
     * an object" — the actual shape is `tsc`'s job, through `defineConfig`'s
     * type, since `nukadoko.config.ts` is TypeScript already. Re-describing
     * `LaunchOptions` field-by-field in zod would need to track every
     * Playwright release, and until that tracking caught up a config author
     * would be told a real Playwright option is a typo — the opposite of
     * what `.strict()` on this schema is for. Which *engine* `launch` runs
     * against is `browserType` above, not this key — `LaunchOptions` itself
     * has no field for that (see `browserType`'s own doc comment for why the
     * two stay separate). This key is launch-only: `newContext`'s options
     * (`viewport`, `locale`, `timezoneId`, `ignoreHTTPSErrors`, ...) are a
     * different Playwright type from `LaunchOptions` and are not accepted
     * here — they go through `browserContext` and `requestContext` below
     * instead, since `browser.newContext()` and
     * `playwrightRequest.newContext()` are two separate Playwright calls
     * with two separate option types. */
    browser: z.custom<LaunchOptions>(
      (value) => typeof value === "object" && value !== null,
    ).optional(),
    /** Playwright's own `BrowserContextOptions` type, taken as-is (same
     * "defer to Playwright's type, don't re-describe it" policy as
     * `browser` above) — passed straight to `browser.newContext()` in
     * src/context/browser-evidence.ts. This is a separate key from
     * `requestContext` below rather than one shared key, because
     * `browser.newContext()` (`ctx.page()`) and
     * `playwrightRequest.newContext()` (`ctx.request()`) are two different
     * Playwright calls with two different option types — even an option
     * name both accept, like `ignoreHTTPSErrors`, is not the same type on
     * both sides, so one key would need a hand-written union or
     * intersection type instead of deferring to Playwright, the same
     * problem `browser`'s doc comment above already argues against.
     * `baseURL` is rejected below even though `BrowserContextOptions`
     * allows it: the world's URL (nukadoko.program.ts) is the only place a
     * project states its base URL, and accepting it here would let a config
     * value silently disagree with the one nukadoko already injects. Rejecting it
     * outright (rather than silently dropping it) is deliberate: a dropped
     * option would leave a config author with something written that
     * quietly does nothing. */
    browserContext: z
      .custom<BrowserContextOptions>((value) => typeof value === "object" && value !== null)
      .superRefine((value, ctx) => {
        if (value.baseURL !== undefined) {
          ctx.addIssue(
            "browserContext.baseURL is not accepted: the world's URL, from serve or url in nukadoko.program.ts, is the only source for baseURL; setting it again here would give two disagreeing answers for the same question.",
          );
        }
      })
      .optional(),
    /** The `ctx.request()` side of the same newContext-options gap
     * `browserContext` closes for `ctx.page()` above — passed straight to
     * `playwrightRequest.newContext()` in src/context/create-context.ts.
     * `RequestContextOptions` (defined above `configSchema`) is how this
     * keeps deferring to Playwright's own type despite Playwright not
     * exporting a name for it — see that type's own doc comment. Same
     * reserved-key rejection, and the same reason, as `browserContext`. */
    requestContext: z
      .custom<RequestContextOptions>((value) => typeof value === "object" && value !== null)
      .superRefine((value, ctx) => {
        if (value.baseURL !== undefined) {
          ctx.addIssue(
            "requestContext.baseURL is not accepted: the world's URL, from serve or url in nukadoko.program.ts, is the only source for baseURL; setting it again here would give two disagreeing answers for the same question.",
          );
        }
      })
      .optional(),
    /** `public` and `redact` answer two different questions about the same
     * key, not opposite claims about the same fact: git's tracked/untracked
     * state is
     * still the only thing that decides *origin* — whether a value is
     * already reachable by anyone with repo access — and neither field
     * disputes that. What they control is *handling*: `public` demotes an
     * individual secret-source key to plain, never redacted (unchanged from
     * before this field existed). `redact` does the opposite direction: it
     * names an individual tracked-file key whose value should still be kept
     * out of new output surfaces (terminal, CI logs, an agent's own
     * conversation transcript) even though the repository itself already
     * has it — a handling instruction, not a claim that the key "is a
     * secret" the way an untracked key's membership in a SecretSet is. Both
     * origins share the same `{{secret.NAME}}` token (no separate
     * `{{redacted.NAME}}`): a step record reader only ever needs to
     * recognize one redaction shape. `MIN_REDACTABLE_LENGTH`
     * (src/secrets/types.ts) still applies to a `redact`-named key exactly
     * as it does to any other
     * secret (src/secrets/build-secret-set.ts) — src/check/config-check.ts's
     * `secrets-redact-key-too-short` warning exists so that limit doesn't
     * silently defeat an explicit `redact` entry. The same key cannot be
     * named in both lists (the refine below): that would be two opposite
     * instructions for one key, and picking a winner would just as often
     * contradict whichever one the author actually meant. Default
     * `{ public: [], redact: [] }`: nothing demoted or promoted unless
     * named. */
    secrets: z
      .object({
        public: z.array(z.string()).default([]),
        redact: z.array(z.string()).default([]),
      })
      .strict()
      .superRefine((value, ctx) => {
        const redactSet = new Set(value.redact);
        for (const key of value.public) {
          if (redactSet.has(key)) {
            ctx.addIssue(
              `secrets.public and secrets.redact both name "${key}": that is two opposite instructions (demote vs. promote) for the same key; remove it from one of the two lists.`,
            );
          }
        }
      })
      .default({ public: [], redact: [] }),
    /** How long a typed step's own `run` may take before the execution is
     * failed with `error.kind: "timeout"`, in milliseconds. A step's own
     * `timeout` overrides it. Compat steps are deliberately not covered:
     * they run unbounded unless their glue declares `{ timeout }` or calls
     * `setDefaultTimeout`, which is what keeps a migrating suite's slow
     * step from starting to fail purely from switching
     * (src/compat/registry.ts, docs/migration.md). A typed step is not a
     * migrating asset, so the same reasoning does not reach it. */
    stepTimeout: z.number().positive().default(DEFAULT_STEP_TIMEOUT_MS),
    /** How long measurement stays on disk (docs/spec.md "Artifacts").
     * `runs`: the newest N `nuka run` invocations keep every record and
     * export file they wrote; at the end of each `nuka run`, an older run's
     * are removed. `adHocDays`: a record no run owns (`nuka do`,
     * or a run that stopped before writing its run.json) is removed once it is older than this many days,
     * since `nuka do --use` reads those across days by design. Neither has an "off" value: a project that
     * wants more history raises the number, and the measurement that
     * motivated the defaults (one heavy suite reached 19 GB in four days
     * with nothing removed) is why "keep everything" is not a setting.
     * Export files are removed only inside the project root: a
     * `nuka report --out` above it keeps its files. */
    retention: z
      .object({
        runs: z.number().int().min(1).default(DEFAULT_RETENTION_RUNS),
        adHocDays: z.number().int().min(1).default(DEFAULT_RETENTION_AD_HOC_DAYS),
      })
      .strict()
      .default({ runs: DEFAULT_RETENTION_RUNS, adHocDays: DEFAULT_RETENTION_AD_HOC_DAYS }),
  })
  .strict();

/** The resolved config: defaults already applied. */
export type NukadokoConfig = z.infer<typeof configSchema>;

/** What `defineConfig` accepts: defaults not yet applied. */
export type NukadokoConfigInput = z.input<typeof configSchema>;
