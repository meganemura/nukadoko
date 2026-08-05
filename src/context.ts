import type { APIRequestContext, BrowserContext, Page } from "playwright";
import type { z } from "zod";
import type { PollOptions } from "./context/poll.js";
import type { Step } from "./step/define-step.js";

// Responsibility: two related shapes, both types only — no implementation
// (the harness that actually launches a browser, restores session state,
// and logs requests belongs to the execution slice, `nuka do` / `nuka
// run`'s src/context/create-context.ts, not this one).
//
// `StepFixtures` (p4a-fixture-bag task spec) is the public one: the bag a
// step's `run(fixtures, args)` destructures by name, per docs/spec.md
// "Context API". The destructuring is a static, readable declaration before
// it is a construction instruction — `page`/`context`/`request` are values,
// not functions, precisely so that a step never has an *action* to reach
// for the browser, only a *name* to have already asked for. `check` (and
// `nuka run`/`nuka do`, sharing the same judgment via src/step/
// validate-fixtures.ts) reads `run`'s own first-argument destructuring
// straight out of its source text (src/step/fixture-names.ts) — the same
// "static declaration drives what actually gets built" shape `from`
// (chained arguments) already established for a step's own output; this
// does it for a resource instead. A step that never names `page`/`context`
// is therefore knowable, before it ever runs, to need no browser at all.
//
// `StepContext` is the older, internal shape: still function-based
// (`page(): Promise<Page>`), still exported from here, because src/
// compat/world.ts's `World.openPage()`/`openRequest()` — untouched by this
// task, `src/compat/**` is out of scope — is typed against it directly and
// this package cannot edit that file to point it at something else. Every
// executor internal that still needs lazy, on-demand access (compat's
// World, and src/context/create-context.ts's own `buildStepFixtures`, which
// resolves a `StepFixtures` bag *from* one of these) keeps using this type;
// only a typed step's own `run` moved to the bag. Kept in sync by
// construction, not by hand: `buildStepFixtures` is the one place a
// `StepContext` ever turns into a `StepFixtures`, so the two shapes cannot
// silently drift apart from each other's members — a name added to one
// without the other fails to compile there.
//
// `resultOf` imports `Step` from step/define-step.ts, which itself imports
// `StepFixtures` from here for its own `run` signature — a type-only cycle
// (both sides use `import type`), which TypeScript resolves fine since
// neither import survives to a runtime value (m2pre-resultof task spec,
// decision 1).
//
// The boundary rule (docs/spec.md "Context API"): a fixture carries only
// what the executor must inject; a helper that needs nothing the executor
// owns stays a plain import instead of a member here. `poll` used to be
// exactly that (`import { poll } from "nukadoko"`, pre-ctx-poll-receipt) —
// until the same mistake `section` made once already (see below) showed up
// again from the other direction: a wait that finishes without being
// recorded cannot be told apart, from a receipt, from one that returned on
// its first attempt, and those two call for opposite fixes (ctx-poll-
// receipt task spec). `poll` therefore became a fixture too; see
// `PollRecord`/`polls` (src/receipt/types.ts) for where a finished call now
// lands.
//
// `section` (t3-sections task spec) reverses m2pre-ctx-surface's original
// call: that decision withheld it because it would have been a no-op until
// a progress-log feature existed. Its actual destination turned out to be
// the receipt, not a live log — `sections: string[]` (docs/spec.md
// "Receipts", src/context/sections.ts) lets a failed step's receipt say
// which stage it reached, which needs no progress-log feature at all. It is
// a bare label-in, nothing-out call (no span, no timing) on purpose: a
// function that wraps a block would have to decide what nesting, async
// boundaries, and early `return`s inside it mean, none of which "where did
// it fail" requires.
//
// `expect` is deliberately not a fixture (p4a-fixture-bag task spec): a
// step imports it directly, `import { expect } from "playwright/test"`.
// Assertion evidence already reaches the receipt through the trace
// (`actions`, src/context/trace-actions.ts — P3a), so `expect` needs
// nothing the executor injects; adding it here would be a member with
// nothing behind it but Playwright's own already-public export, violating
// the same boundary rule above.
//
// `browser` is deliberately not a fixture either. `context` is (the
// `BrowserContext` `page` already belongs to, via `page.context()` —
// nothing new to launch), because it lets a step open a second tab
// (`context.newPage()`) while staying inside the one browser context the
// executor already owns and measures. `browser` itself would let a step
// call `browser.newContext()` and mint a context the executor never sees —
// unmeasured, untraced, outside every receipt this run writes. Not
// exporting the name is what keeps that always unreachable through the bag,
// rather than a rule a step has to remember not to break.
//
// `evidence` (P9 task spec) is the fixture-shaped counterpart to Playwright's
// own `testInfo.attach()`/`testInfo.outputPath()`: every automatic evidence
// field on a receipt (trace, screenshots, http.jsonl, page_events, ...) is
// something the harness collects on its own, and nothing existed for the
// application-specific evidence only a step can produce — an API response
// body, a DB snapshot, a generated file's contents. `attach`/`path` are two
// methods on one object, not two separate fixtures, because both need the
// exact same thing from the executor (which directory this step's own
// evidence lives in — src/context/evidence.ts's own `dirOf` getter, the
// same moving pointer `ctx.request()`'s http.jsonl logging already reads),
// and a step reaching for one is reaching for the other exactly as often.
// The boundary rule this file opened with is why this is a fixture at all:
// the directory itself is executor-only knowledge (create-context.ts's
// `beginStep` is the only thing that ever moves it), so a step can name an
// attachment but can never learn, or control, where it actually lands.

export interface StepFixtures {
  /** Playwright Page; the browser launches when this name is destructured
   * (docs/spec.md "Context API") — restored from the session's
   * storageState, with the configured baseURL wired into the browser
   * context so `page.goto("/path")` resolves against it. A step that never
   * destructures `page` (or `context`) never causes a browser to launch at
   * all. */
  readonly page: Page;
  /** The `BrowserContext` `page` belongs to — same launch as `page` above,
   * never a second one. Exists so a step that needs a second tab
   * (`context.newPage()`) can open one without reaching for `browser`
   * (not a fixture at all — see this file's own header for why). */
  readonly context: BrowserContext;
  /** Playwright APIRequestContext with the configured baseURL and the
   * session's cookies; built when this name is destructured. */
  readonly request: APIRequestContext;
  /** Environment variables from the configured envFiles (read-only). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a required env var: same source as `env[name]`, minus the
   * presence check every step calling `env[name]` ended up writing for
   * itself (t2-require-env task spec — real migrations kept re-deriving the
   * same `need()` helper, with a different error message each time). Throws
   * `MissingEnvError` (src/context/errors.ts) when `name` is unset *or* set
   * to the empty string — an envFile's `KEY=` line sets no value, so an
   * empty string is treated as "not set", not as a deliberately-chosen empty
   * value (see `MissingEnvError`'s own doc comment for why). Returns
   * `string`, never `undefined`: the whole point is not needing an
   * `if (!value) throw` at every call site. */
  readonly requireEnv: (name: string) => string;
  /** The configured baseURL. `undefined` when the config doesn't set one;
   * `request`'s own construction is what raises the "which key to set"
   * error, not this type. */
  readonly baseURL: string | undefined;
  /** The validated `result` of `step`'s most recent successful execution in
   * the current scenario, matched by the Step object's own identity — not
   * by name (docs/spec.md "Context API", m2pre-resultof task spec, decision
   * 1). `undefined` under `nuka do`, or when `step` hasn't succeeded yet in
   * this scenario; a step that failed never becomes readable, since only a
   * validated (`returns`-schema-passing) result ever enters the chain. Every
   * read that returns a value is measured: the executor records it as
   * provenance on this execution's own receipt (`used`), so the dependency
   * is visible twice — as a static `import` of `step`, and at run time in
   * the receipt chain (docs/spec.md "Receipts"). */
  readonly resultOf: <S extends Step>(step: S) => z.infer<S["returns"]> | undefined;
  /** Marks that execution has reached stage `label` — this task's spec,
   * decision 1. Synchronous and void: there is no matching "end" call and
   * no return value, so calling it costs nothing to place before an
   * `await`, inside a loop, or right before a step throws. Every call is
   * appended, in call order, to this execution's receipt under
   * `sections`; a step that never calls it gets no `sections` key at all
   * (empty is omitted, the same convention `used` already follows). */
  readonly section: (label: string) => void;
  /** Waits for `fn` to return a defined value, retrying at
   * `options.interval` (default 500ms) until `options.timeout` (default
   * 30_000ms) is reached; throws `PollTimeoutError` (src/context/poll.ts)
   * if it is. `fn`'s own throw propagates unchanged. Every completed call —
   * resolved, timed out, or `fn` itself threw — is recorded on this
   * execution's receipt under `polls` (docs/spec.md "Receipts"): how many
   * attempts it took, how long it waited, and how it ended. */
  readonly poll: <T>(fn: () => Promise<T | undefined>, options?: PollOptions) => Promise<T>;
  /** The application-specific evidence fixture (P9 task spec; this file's
   * own header) — `attach(name, body)` writes `body` (`string | Uint8Array`)
   * to this execution's own evidence directory and records
   * `{ name, file, at }` on the receipt's `evidence.attachments` (docs/
   * spec.md "Receipts"); calling it twice with the same `name` keeps both
   * files, never overwriting the first. `path(name)` allocates a
   * collision-free absolute path under that same directory without writing
   * anything — Playwright's own `testInfo.outputPath()` — and only a path
   * that actually has a file on it by the time this execution ends is
   * listed on the receipt. Both throw `InvalidEvidenceNameError` (src/
   * context/errors.ts) for a `name` containing a path separator or equal to
   * `"."`/`".."`/`""`: refused, never silently rewritten. Capped at 100
   * attachments per execution, the true total reported on
   * `truncated.evidence` once that cap is hit, the same sibling-field
   * convention `truncated.actions` already uses. */
  readonly evidence: {
    readonly attach: (name: string, body: string | Uint8Array) => Promise<void>;
    readonly path: (name: string) => string;
  };
}

/** Every name `StepFixtures` carries, kept in sync with that interface by
 * construction rather than by hand (p4a-fixture-bag task spec): the object
 * literal below is typed as `Record<keyof StepFixtures, true>`, so a member
 * added to (or removed from) `StepFixtures` without a matching edit here
 * fails to compile. This is the one, closed set src/step/validate-
 * fixtures.ts checks a step's own destructured names against, and the one
 * src/context/create-context.ts's `buildStepFixtures` switches over to
 * build the bag — spec's own closed-set rule (CLAUDE.md: "a contract says
 * what the step demands"), not a list a future fixture can silently miss
 * updating. */
const FIXTURE_NAME_MEMBERSHIP: Record<keyof StepFixtures, true> = {
  page: true,
  context: true,
  request: true,
  env: true,
  requireEnv: true,
  baseURL: true,
  resultOf: true,
  section: true,
  poll: true,
  evidence: true,
};

export const BUILTIN_FIXTURE_NAMES: readonly string[] = Object.keys(FIXTURE_NAME_MEMBERSHIP);

export interface StepContext {
  /** Playwright Page; browser launches on first call, restored from the
   * session's storageState, with the configured baseURL wired into the
   * browser context so `page.goto("/path")` resolves against it. */
  page(): Promise<Page>;
  /** Playwright APIRequestContext with the configured baseURL and the session's cookies. */
  request(): Promise<APIRequestContext>;
  /** Environment variables from the configured envFiles (read-only). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a required env var: same source as `ctx.env[name]`, minus the
   * presence check every step calling `ctx.env[name]` ended up writing for
   * itself (t2-require-env task spec — real migrations kept re-deriving the
   * same `need()` helper, with a different error message each time). Throws
   * `MissingEnvError` (src/context/errors.ts) when `name` is unset *or* set
   * to the empty string — an envFile's `KEY=` line sets no value, so an
   * empty string is treated as "not set", not as a deliberately-chosen empty
   * value (see `MissingEnvError`'s own doc comment for why). Returns
   * `string`, never `undefined`: the whole point is not needing an
   * `if (!value) throw` at every call site. */
  requireEnv(name: string): string;
  /** The configured baseURL. `undefined` when the config doesn't set one;
   * `request()` is what raises the "which key to set" error, not this type. */
  readonly baseURL: string | undefined;
  /** The validated `result` of `step`'s most recent successful execution in
   * the current scenario, matched by the Step object's own identity — not
   * by name (docs/spec.md "Context API", m2pre-resultof task spec, decision
   * 1). `undefined` under `nuka do`, or when `step` hasn't succeeded yet in
   * this scenario; a step that failed never becomes readable, since only a
   * validated (`returns`-schema-passing) result ever enters the chain. Every
   * read that returns a value is measured: the executor records it as
   * provenance on this execution's own receipt (`used`), so the dependency
   * is visible twice — as a static `import` of `step`, and at run time in
   * the receipt chain (docs/spec.md "Receipts"). */
  resultOf<S extends Step>(step: S): z.infer<S["returns"]> | undefined;
  /** Marks that execution has reached stage `label` — this task's spec,
   * decision 1. Synchronous and void: there is no matching "end" call and
   * no return value, so calling it costs nothing to place before an
   * `await`, inside a loop, or right before a step throws. Every call is
   * appended, in call order, to this execution's receipt under
   * `sections`; a step that never calls it gets no `sections` key at all
   * (empty is omitted, the same convention `used` already follows). */
  section(label: string): void;
  /** Waits for `fn` to return a defined value, retrying at
   * `options.interval` (default 500ms) until `options.timeout` (default
   * 30_000ms) is reached; throws `PollTimeoutError` (src/context/poll.ts)
   * if it is. `fn`'s own throw propagates unchanged. Every completed call —
   * resolved, timed out, or `fn` itself threw — is recorded on this
   * execution's receipt under `polls` (docs/spec.md "Receipts"): how many
   * attempts it took, how long it waited, and how it ended. */
  poll<T>(fn: () => Promise<T | undefined>, options?: PollOptions): Promise<T>;
  /** The application-specific evidence fixture (P9 task spec) — see
   * `StepFixtures.evidence`'s own doc comment above for the full contract;
   * this is the same object, reached the older, function-based way every
   * other member of this interface is. */
  readonly evidence: {
    readonly attach: (name: string, body: string | Uint8Array) => Promise<void>;
    readonly path: (name: string) => string;
  };
}
