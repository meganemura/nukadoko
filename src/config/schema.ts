import type { APIRequest, BrowserContextOptions, LaunchOptions } from "playwright";
import { z } from "zod";

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

export const configSchema = z
  .object({
    featuresDir: z.string().default("features"),
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
     * what `.strict()` on this schema is for. Chromium is the only browser
     * type (no key here selects firefox/webkit — out of scope until there
     * is demand). This key is launch-only: `newContext`'s options
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
    /** Individual secret-source keys to demote to plain (never redacted).
     * Default `{ public: [] }`: nothing is public unless named. There is no
     * promotion counterpart — a tracked file's value is definitionally not a
     * secret (docs/spec.md "Secrets"), so making one a secret would need a
     * different mechanism than this one, out of scope here. */
    secrets: z
      .object({ public: z.array(z.string()).default([]) })
      .strict()
      .default({ public: [] }),
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
