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

export interface PollOptions {
  /** Total time budget for polling, in milliseconds. */
  timeout?: number;
  /** Delay between poll attempts, in milliseconds. */
  interval?: number;
  /** Human-readable label surfaced in the run's progress log. */
  description?: string;
}

export interface StepContext {
  /** Playwright Page; browser launches on first call, restored from the session's storageState. */
  page(): Promise<Page>;
  /** Playwright APIRequestContext with the configured baseURL and the session's cookies. */
  request(): Promise<APIRequestContext>;
  /** submit-poll-fetch against asynchronous jobs. */
  poll<T>(fn: () => Promise<T>, options?: PollOptions): Promise<T>;
  /** Names a stretch of the run in its progress log. */
  section(name: string): void;
  /** Environment variables from the configured envFiles (read-only). */
  readonly env: Readonly<Record<string, string | undefined>>;
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
