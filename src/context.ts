import type { APIRequestContext, Page } from "playwright";
import type { z } from "zod";
import type { PollOptions } from "./context/poll.js";
import type { Step } from "./step/define-step.js";

// Responsibility: the shape of `ctx` a step's `run(ctx, args)` receives, per
// docs/spec.md "Context API". Types only — no implementation. The harness
// that actually launches a browser, restores session state, and logs
// requests belongs to the execution slice (`nuka do` / `nuka run`), not this
// one. This type exists now only so step files (this slice's discovery
// fixtures included) type-check against a real `run` signature.
//
// `resultOf` imports `Step` from step/define-step.ts, which itself imports
// `StepContext` from here for its own `run` signature — a type-only cycle
// (both sides use `import type`), which TypeScript resolves fine since
// neither import survives to a runtime value (m2pre-resultof task spec,
// decision 1).
//
// The boundary rule (docs/spec.md "Context API"): `ctx` carries only what
// the executor must inject; a helper that needs nothing the executor owns
// stays a plain import instead of a member here. `poll` used to be exactly
// that (`import { poll } from "nukadoko"`, pre-ctx-poll-receipt) — until the
// same mistake `section` made once already (see below) showed up again from
// the other direction: a wait that finishes without being recorded cannot
// be told apart, from a receipt, from one that returned on its first
// attempt, and those two call for opposite fixes (ctx-poll-receipt task
// spec). `poll` therefore moved onto `ctx` too; see `PollRecord`/`polls`
// (src/receipt/types.ts) for where a finished call now lands.
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
}
