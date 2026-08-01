import type { APIRequestContext, Page } from "playwright";

// Responsibility: the shape of `ctx` a step's `run(ctx, args)` receives, per
// docs/spec.md "Context API". Types only — no implementation. The harness
// that actually launches a browser, restores session state, and logs
// requests belongs to the execution slice (`nuka do` / `nuka run`), not this
// one. This type exists now only so step files (this slice's discovery
// fixtures included) type-check against a real `run` signature.

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
}
