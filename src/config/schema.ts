import type { APIRequest, BrowserContextOptions, LaunchOptions } from "playwright";
import { z } from "zod";
import type { FixtureDefinition } from "../fixture/types.js";

// Responsibility: the validated shape of nukadoko.config.ts's default
// export, per docs/spec.md's config section (featuresDir, baseURL, envFiles,
// environments, stateDir, browser, browserContext, requestContext, secrets,
// parameterTypes). `.strict()` is
// what makes an unknown key an error instead of a silent no-op. `environments`
// is now typed exactly (m1-environments task spec, decision 1): baseURL/
// envFiles per environment layer on top of the top-level values (resolution
// lives in src/environment/resolve-environment.ts, not here), `policy:
// "read-only"` and `version` exist only per-environment. `browser` takes
// Playwright's own `LaunchOptions` type directly (t6-config-browser task
// spec, decision 1) rather than a bespoke enumeration — see the field's own
// doc comment for why zod does not re-validate its shape. `secrets` is
// typed differently again (m1-secrets task spec, scope item 2): its one
// field is small and fully designed by docs/spec.md today, so it is typed
// exactly, the same as `environments` above but for the opposite reason
// `browser` is not — there is no upstream type to defer to for it.
// `parameterTypes` (m2pre-parameter-types task spec, decision 1) is typed
// exactly for the same reason `secrets` is: docs/spec.md fully designs its
// one shape today, `{ name, regexp, transformer? }`. Registering it — and
// rejecting a name that collides with a built-in type or another entry in
// this same list — is src/binding/registry.ts's job, not this schema's; a
// zod schema only rejects shapes, not cross-entry relationships.

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

// A parameter type's own name, same character set as a session/environment
// name (src/session/name.ts, ENVIRONMENT_NAME_PATTERN above) for the same
// reason those are restricted: it is not filesystem-derived here, but it is
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
 * schema for either, the same reason `environments.*.version` above uses it.
 * `transformer` is intentionally typed as accepting/returning `unknown` —
 * its return value is not statically checked (this task's spec, decision 4:
 * a custom type's captured value skips check's capture-type-mismatch
 * comparison entirely, since `capture.type` for a custom type never equals
 * "int"/"float"/"string"/"word" — see src/check/binding-check.ts); the args
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

/** `APIRequest.newContext`'s options (`requestContext` below) have no named
 * export from Playwright the way `BrowserContextOptions` does
 * (`browserContext` below) — `APIRequest.newContext`'s argument is declared
 * inline. Referencing it through `Parameters<>` rather than redefining it
 * here keeps the same "use Playwright's own type as-is" policy `browser` and
 * `browserContext` both follow (see their doc comments): only the name is
 * missing upstream, not the type itself. */
type RequestContextOptions = NonNullable<Parameters<APIRequest["newContext"]>[0]>;

// Same character set requirement as an environment/parameter-type name
// (`ENVIRONMENT_NAME_PATTERN`/`PARAMETER_TYPE_NAME_PATTERN` above), but
// stricter still: a fixture name is destructured directly (`{ tenant }`,
// src/step/fixture-names.ts), so it must be a legal JS identifier, not just
// an unambiguous, easy-to-diff string — a leading digit or a hyphen would
// make the very destructuring pattern this key exists to be named by a
// syntax error.
const FIXTURE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isFixtureFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/** `config.fixtures.<name>`'s own shape (P5 task spec, scope items 1, 4) —
 * zod's job here stops at "is this a function, or a `[function, options]`
 * tuple, and is `options` itself well-formed" (the same shallow "is this an
 * object" contract `browser`/`browserContext`/`requestContext` above keep
 * for their own Playwright-deferred types); a fixture's own *dependency
 * names* (unknown name, default value, `...rest`, not destructured at all)
 * are not zod's concern — those are read from the function's own source
 * text and validated by src/step/validate-fixtures.ts, run over the
 * *resolved* config (loadConfig's own caller), the same split defineConfig/
 * loadConfig already keep for the rest of this file.
 *
 * `auto: true` is refused right here, at config-load time, with a message
 * naming *why* (P5 task spec, scope item 4) — the one option this schema
 * does treat as a hard, structural mistake rather than deferring to a later
 * check: accepting it would be the first claim this package would be
 * breaking about its own fixture support (`.claude-team/
 * playwright-native-design.md` 3 節: "「Playwright fixture 互換」とは名乗
 * らない" — engine-constructed-without-being-named is exactly what CLAUDE.md's
 * "the feature file names everything that ran" principle exists to forbid). */
const fixtureDefinitionSchema: z.ZodType<FixtureDefinition> = z
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
    if (obj.scope !== undefined && obj.scope !== "scenario" && obj.scope !== "run") {
      ctx.addIssue(
        `fixture options.scope must be "scenario" or "run" (got ${JSON.stringify(obj.scope)}); "worker" does ` +
          'not exist yet: there is no parallel execution for it to mean anything different from "run"',
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
    /** `featuresDir` is the set that runs with no argument (`nuka run`,
     * `nuka check`, `nuka tend` all default to it); `additionalFeatureDirs`
     * is a second, disjoint set that never runs on its own but still binds
     * vocabulary — a step's pattern is bound or unbound as a property of the
     * whole project, not just of what `nuka run` would execute today
     * (fb3-scan-dirs task spec, decision 1). This is why an acceptance
     * feature — recommended to live outside `featuresDir` precisely so it is
     * never picked up as a regression (skills/acceptance/SKILL.md) — belongs
     * here: it must never run unattended, but a static check that doesn't
     * see it will wrongly call the steps it uses unbound. `nuka check`
     * (no argument) and `nuka tend` read both sets; `nuka run` (no argument)
     * reads only `featuresDir`, unchanged — this asymmetry is the field's
     * whole point, not an oversight. Default `[]`: nothing extra is scanned
     * unless named. */
    additionalFeatureDirs: z.array(z.string()).default([]),
    stateDir: z.string().default(".nukadoko"),
    baseURL: z.string().optional(),
    envFiles: z.array(z.string()).optional(),
    environments: z
      .record(z.string().regex(ENVIRONMENT_NAME_PATTERN), environmentConfigSchema)
      .optional(),
    // Default `[]`: registering nothing is the common case, and every
    // consumer (src/binding/registry.ts's factory) already treats "no custom
    // types" as its own no-op default, so this mirrors that rather than
    // making every call site handle `undefined` separately.
    parameterTypes: z.array(parameterTypeConfigSchema).default([]),
    /** User-defined fixtures (P5 task spec, scope items 1, 3) — layered
     * *after* the builtin set (`page`/`context`/`request`/... —
     * src/context.ts's `BUILTIN_FIXTURE_NAMES`), so a key here with the
     * same name as a builtin overrides it (src/fixture/graph.ts's own
     * layering rule). Default `{}`: no user fixtures unless named, the
     * same "nothing extra unless named" convention `parameterTypes` above
     * and `additionalFeatureDirs` below both already follow. */
    fixtures: z.record(z.string().regex(FIXTURE_NAME_PATTERN), fixtureDefinitionSchema).default({}),
    /** The default setup/teardown timeout every fixture instance gets
     * (milliseconds), overridable per fixture via that fixture's own
     * `options.timeout` (P5 task spec, scope item 7) — without a default,
     * a fixture that forgets to call `use(...)` would leave `nuka run`
     * hanging indefinitely instead of failing with a named cause
     * (src/fixture/lifecycle.ts's own `FixtureTimeoutError`). */
    fixtureTimeout: z.number().positive().default(60_000),
    /** Which Playwright browser engine `ctx.page()` launches (p6-browser-type
     * task spec) — deliberately a separate key from `browser` below, never a
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
    /** Playwright's own `LaunchOptions` type, taken as-is (t6-config-browser
     * task spec, decision 1): coupling to Playwright is an accepted design
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
     * `baseURL` and `storageState` are rejected below even though
     * `BrowserContextOptions` allows them: `config.baseURL` is meant to be
     * the only place a project states its base URL, and nukadoko's session
     * mechanism is what owns `storageState` (src/context/create-context.ts)
     * — accepting either here would let a config value silently disagree
     * with, or overwrite, the one nukadoko already injects. Rejecting them
     * outright (rather than silently dropping them) is deliberate: a
     * dropped option would leave a config author with something written
     * that quietly does nothing. */
    browserContext: z
      .custom<BrowserContextOptions>((value) => typeof value === "object" && value !== null)
      .superRefine((value, ctx) => {
        if (value.baseURL !== undefined) {
          ctx.addIssue(
            "browserContext.baseURL is not accepted: config.baseURL is the only source for baseURL; setting it again here would give config two disagreeing answers for the same question.",
          );
        }
        if (value.storageState !== undefined) {
          ctx.addIssue(
            "browserContext.storageState is not accepted: nukadoko's session mechanism sets storageState itself; setting it here would silently override (and could break) a restored session.",
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
     * reserved-key rejection, and the same reasons, as `browserContext`. */
    requestContext: z
      .custom<RequestContextOptions>((value) => typeof value === "object" && value !== null)
      .superRefine((value, ctx) => {
        if (value.baseURL !== undefined) {
          ctx.addIssue(
            "requestContext.baseURL is not accepted: config.baseURL is the only source for baseURL; setting it again here would give config two disagreeing answers for the same question.",
          );
        }
        if (value.storageState !== undefined) {
          ctx.addIssue(
            "requestContext.storageState is not accepted: nukadoko's session mechanism sets storageState itself; setting it here would silently override (and could break) a restored session.",
          );
        }
      })
      .optional(),
    /** `public` and `redact` answer two different questions about the same
     * key, not opposite claims about the same fact (secrets-redact-and-
     * warning task spec, decision A1): git's tracked/untracked state is
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
     * `{{redacted.NAME}}`): a receipt reader only ever needs to recognize
     * one redaction shape. `MIN_REDACTABLE_LENGTH` (src/secrets/types.ts)
     * still applies to a `redact`-named key exactly as it does to any other
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
    /** `resultsDir` is root-relative; omitted, it defaults to
     * `<stateDir>/allure-results` (docs/spec.md "The state directory") —
     * that default is applied where `stateDir` is resolved (src/cli/run.ts),
     * not here, since this schema alone doesn't know `stateDir`'s final
     * value. No `enabled` key (m3b-allure-emitter spec-b2 task spec: the
     * emitter is always on — zero configuration already gets a full report,
     * so there is nothing to opt into). No CLI flag either. */
    allure: z.object({ resultsDir: z.string().optional() }).strict().optional(),
    /** `output` is root-relative; omitted, it defaults to
     * `<stateDir>/messages.ndjson` — that default is applied where
     * `stateDir` is resolved (src/cli/run.ts), not here, same split as
     * `allure.resultsDir` above. No `enabled` key (m3c-messages-emitter
     * spec-b task spec: the emitter is always on, same reason as `allure`
     * above — zero configuration already gets a full stream). No CLI flag
     * either. */
    messages: z.object({ output: z.string().optional() }).strict().optional(),
  })
  .strict();

/** The resolved config: defaults already applied. */
export type NukadokoConfig = z.infer<typeof configSchema>;

/** What `defineConfig` accepts: defaults not yet applied. */
export type NukadokoConfigInput = z.input<typeof configSchema>;
