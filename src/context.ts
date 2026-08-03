import type { APIRequestContext, Page } from "playwright";
import type { z } from "zod";
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
// the executor must inject; pure helpers are imports, not context members.
// `poll` (`import { poll } from "nukadoko"`, src/context/poll.ts) needs
// nothing the executor owns, so it is not here. `section` is not here
// either, for the opposite reason — it would do nothing until the
// progress-log feature exists (m2pre-ctx-surface task spec).

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
}
