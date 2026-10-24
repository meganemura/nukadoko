import type { APIRequestContext, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { z } from "zod";
import type { RunStep, Step } from "./define-step.js";

// Responsibility: two related shapes, both types only — no implementation
// (the harness that actually launches a browser
// and logs requests belongs to the execution slice, `nuka do` / `nuka
// run`'s src/context/create-context.ts, not this one).
//
// `StepFixtures` is the public one: the bag a step's `run(fixtures, args)`
// destructures by name, per docs/spec.md "Context API". The destructuring
// is a static, readable declaration before
// it is a construction instruction — `page`/`context`/`request` are values,
// not functions, precisely so that a step never has an *action* to reach
// for the browser, only a *name* to have already asked for. `check` (and
// `nuka run`/`nuka do`, sharing the same judgment via src/fixture/
// validate-fixtures.ts) reads `run`'s own first-argument destructuring
// straight out of its source text (src/step/fixture-names.ts) — the same
// "static declaration drives what actually gets built" shape `from`
// (chained arguments) already established for a step's own output; this
// does it for a resource instead. A step that never names `page`/`context`
// is therefore knowable, before it ever runs, to need no browser at all.
//
// `StepContext` is the older, internal shape: still function-based
// (`page(): Promise<Page>`), still exported from here. Compat's World does
// not import it. World only calls `page()` and `request()`, and it declares
// that pair itself (src/compat/world.ts) so the compat package stays a
// leaf. Every executor internal that still needs lazy, on-demand access
// (src/context/create-context.ts's own `buildStepFixtures`, which resolves
// a `StepFixtures` bag *from* one of these) keeps using this type; only a
// typed step's own `run` moved to the bag. Kept in sync by construction,
// not by hand: `buildStepFixtures` is the one place a `StepContext` ever
// turns into a `StepFixtures`, so the two shapes cannot silently drift
// apart from each other's members. A name added to one without the other
// fails to compile there.
//
// `resultOf` imports `Step` from step/define-step.ts, which itself imports
// `StepFixtures` from here for its own `run` signature — a type-only cycle
// (both sides use `import type`), which TypeScript resolves fine since
// neither import survives to a runtime value.
//
// The boundary rule (docs/spec.md "Context API"): a fixture carries only
// what the executor must inject; a helper that needs nothing the executor
// owns stays a plain import instead of a member here. `poll` used to be
// exactly that (`import { poll } from "nukadoko"`) — until the same
// mistake `section` made once already (see below) showed up again from the
// other direction: a wait that finishes without being recorded cannot be
// told apart, from a step record, from one that returned on its first
// attempt, and those two call for opposite fixes. `poll` therefore became a
// fixture too; see `PollRecord`/`polls` (src/record/types.ts) for where a
// finished call now lands.
//
// `section` reverses an earlier decision that left it out: that decision
// withheld it because it would have been a no-op until a progress-log
// feature existed. That feature exists now (src/run/progress-log.ts —
// `nuka run`'s own stderr progress lines), but `section`'s own destination
// turned out to be the step record, not that live log: `sections: string[]`
// (docs/spec.md "Records",
// src/context/sections.ts) lets a failed step's step record say which stage
// it reached, a fact this file's own read (the run summary, a report, an agent
// re-reading a step record later) needs regardless of whether anyone was
// watching stderr while the step ran. It is a bare label-in, nothing-out
// call (no span, no timing) on purpose: a function that wraps a block would
// have to decide what nesting, async boundaries, and early `return`s inside
// it mean, none of which "where did it fail" requires.
//
// `expect` is deliberately not a fixture: a step imports it directly,
// `import { expect } from "playwright/test"`.
// Assertion evidence already reaches the step record through the trace
// (`actions`, src/context/trace-actions.ts), so `expect` needs
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
// unmeasured, untraced, outside every step record this run writes. Not
// exporting the name is what keeps that always unreachable through the bag,
// rather than a rule a step has to remember not to break.
//
// `pageAs` is the measured way to a second browser context, the one
// `browser` was refused for above. A scenario with several people in it
// (each with their own cookies, storage, and options such as
// `javaScriptEnabled`) needs a context per person, and `context.newPage()`
// shares one cookie jar. `pageAs(name)` opens that context in the browser
// the executor launched, with the same subscriptions, its own trace chunks,
// and its own final screenshot, so it stays inside every step record the
// run writes. It is a function rather than a value because the names are
// the scenario's data (`aki`, `ben`), not something a destructuring
// pattern can list; destructuring `pageAs` is still what tells `check`
// that the step may open a browser.
//
// `call` (docs/spec.md "Parts") runs one of the step's own declared `parts`
// — a `Step` a step reaches for the same static way it reaches for a
// fixture: `parts` is read before `run()` starts, never inferred from where
// `call` happens to be invoked inside the body, so a caller whose part
// reaches for `page` needs `page` in its own bag exactly as if it had
// destructured that name itself (src/step/step-fixture-names.ts's
// `stepFixtureNames` is what closes that need transitively before either
// function runs). A part shares the calling step's own `ctx` outright — its
// `observed`/`sections`/`used`/`required_env`/evidence/trace all land on the
// *calling* step's own step record, never a step record of its own — so
// `call`'s own bag for the part is a subset of the exact fixture values the
// caller already has, not a freshly built one; this is what a part destined
// for `env`/`resultOf`/`section`/`poll`/`evidence` reaches without this
// module doing anything special for any one of those names. Refuses a
// `Step` this step's own `parts` never named, and a `Step` discovery never
// registered, before running anything — the same "never began" shape
// `ctx.resultOf`'s own `UnregisteredStepError` already has. Every call,
// successful or not, is recorded on the calling step's own step record
// under `calls` (docs/spec.md "Records"), never as a step record of its
// own — the feature file names every step record that exists, and a part
// call is depth under one of those, not a new entry the feature never
// asked for.
//
// `evidence` is the fixture-shaped counterpart to Playwright's own
// `testInfo.attach()`/`testInfo.outputPath()`: every automatic evidence
// field on a step record (trace, screenshots, http.jsonl, page_events, ...) is
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

export interface PollOptions {
  /** Total time budget for the whole poll, in milliseconds, including the
   * attempt in flight. Must be a finite number greater than zero when
   * given. Omit it for 30 seconds. */
  timeout?: number;
  /** Delay between poll attempts, in milliseconds. Must be a finite number
   * greater than zero when given. Omit it for 500 milliseconds. */
  interval?: number;
  /** Human-readable label. Included in `PollTimeoutError`'s message when
   * this poll times out, and in the step record's own `polls` entry
   * regardless of how the poll ended (docs/spec.md "Records") — the same label both
   * names the failure and identifies the record of the wait that produced
   * it. */
  description?: string;
}

export interface StepFixtures {
  /** Playwright Page; the browser launches when this name is destructured
   * (docs/spec.md "Context API"), in a fresh context built from
   * `config.browserContext`, with the world's base URL wired into the browser
   * context so `page.goto("/path")` resolves against it. A step that never
   * destructures `page` (or `context`) never causes a browser to launch at
   * all. */
  readonly page: Page;
  /** The `BrowserContext` `page` belongs to — same launch as `page` above,
   * never a second one. Exists so a step that needs a second tab
   * (`context.newPage()`) can open one without reaching for `browser`
   * (not a fixture at all — see this file's own header for why). */
  readonly context: BrowserContext;
  /** The page of a browser context of its own, named `name`, in the same
   * browser as `page` (this file's own header). Its cookies and storage are
   * its own, and `options` (Playwright's own `BrowserContextOptions`, such
   * as `javaScriptEnabled: false`) apply to it alone, over
   * `config.browserContext`; `baseURL` is wired in as for `page`. The
   * context opens on the first call for `name` in a scenario, and a later
   * call returns the same page. A later call with different `options`
   * throws `ContextOptionsConflictError`, and a name that is not 1 to 64
   * lowercase letters, digits, and hyphens throws `InvalidContextNameError`
   * (src/context/context-name.ts). Closed when the scenario ends, after its
   * final screenshot (`final.<name>.png`). The context is `page.context()`. */
  readonly pageAs: (name: string, options?: BrowserContextOptions) => Promise<Page>;
  /** Playwright APIRequestContext with the world's base URL, built from
   * `config.requestContext` when this name is destructured. */
  readonly request: APIRequestContext;
  /** Environment variables from the configured envFiles, then the world's
   * `env` from nukadoko.program.ts. A frozen copy of
   * the merged map: assigning a property throws in a step module, so a
   * write in one step is not visible to a later step or a later scenario.
   * A configured key still reads back as the loaded value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a required env var: same source as `env[name]`, minus the
   * presence check every step calling `env[name]` ended up writing for
   * itself (real migrations kept re-deriving the same `need()` helper, with
   * a different error message each time). Throws
   * `MissingEnvError` (src/context/errors.ts) when `name` is unset *or* set
   * to the empty string — an envFile's `KEY=` line sets no value, so an
   * empty string is treated as "not set", not as a deliberately-chosen empty
   * value (see `MissingEnvError`'s own doc comment for why). Returns
   * `string`, never `undefined`: the whole point is not needing an
   * `if (!value) throw` at every call site. */
  readonly requireEnv: (name: string) => string;
  /** The world's base URL: the port nukadoko gave `serve`, or the program
   * file's `url`. `undefined` with no program file, or a world with
   * neither; `request`'s own construction is what raises the error for a
   * relative URL then, not this type. */
  readonly baseURL: string | undefined;
  /** The validated `result` of `step`'s most recent successful execution in
   * the current scenario, matched by the Step object's own identity — not
   * by name (docs/spec.md "Context API"). `undefined` under `nuka do`, or
   * when `step` hasn't succeeded yet in this scenario; a step that failed
   * never becomes readable, since only a
   * validated (`returns`-schema-passing) result ever enters the chain. Every
   * read that returns a value is measured: the executor records it as
   * provenance on this execution's own step record (`used`), so the dependency
   * is visible twice — as a static `import` of `step`, and at run time in
   * the step record chain (docs/spec.md "Records"). */
  readonly resultOf: <S extends Step>(step: S) => z.infer<S["returns"]> | undefined;
  /** Marks that execution has reached stage `label`. Synchronous and void:
   * there is no matching "end" call and
   * no return value, so calling it costs nothing to place before an
   * `await`, inside a loop, or right before a step throws. Every call is
   * appended, in call order, to this execution's step record under
   * `sections`; a step that never calls it gets no `sections` key at all
   * (empty is omitted, the same convention `used` already follows). */
  readonly section: (label: string) => void;
  /** Waits for `fn` to return a defined value, retrying at
   * `options.interval` (default 500ms) until `options.timeout` (default
   * 30_000ms). That timeout is a budget for the whole call, including the
   * attempt in flight: an attempt that has not settled when the budget ends
   * throws `PollTimeoutError` (src/context/poll.ts), and a value that
   * arrives later is not returned. A non-finite or non-positive `timeout`
   * or `interval` throws `InvalidPollOptionsError` before the first attempt.
   * `fn`'s own throw propagates unchanged. Every completed call —
   * resolved, timed out, or `fn` itself threw — is recorded on this
   * execution's step record under `polls` (docs/spec.md "Records"): how many
   * attempts it took, how long it waited, and how it ended. */
  readonly poll: <T>(fn: () => Promise<T | undefined>, options?: PollOptions) => Promise<T>;
  /** Runs `part`, one of this step's own declared `parts` (docs/spec.md
   * "Parts"), with `args` validated against `part`'s own `args` schema and
   * the returned value validated against `part`'s own `returns` — the same
   * two checks a step run through `nuka run`/`nuka do` already gets. Throws
   * when `part` isn't in this step's own `parts` list, or when it isn't a
   * `Step` discovery registered (this file's own header). Recorded on the
   * calling step's own step record under `calls`, nested when a part calls
   * a part of its own. */
  readonly call: <S extends RunStep>(part: S, args: z.input<S["args"]>) => Promise<z.infer<S["returns"]>>;
  /** The application-specific evidence fixture (this file's
   * own header) — `attach(name, body)` writes `body` (`string | Uint8Array`)
   * to this execution's own evidence directory and records
   * `{ name, file, at }` on the step record's `evidence.attachments` (docs/
   * spec.md "Records"); calling it twice with the same `name` keeps both
   * files, never overwriting the first. A `name` that differs only by case
   * counts as the same name, so the second call is suffixed the same way
   * and the two cannot share one path on a case-insensitive volume.
   * `path(name)` allocates a
   * collision-free absolute path under that same directory without writing
   * anything — Playwright's own `testInfo.outputPath()` — and only a path
   * that actually has a file on it by the time this execution ends is
   * listed on the step record. Both throw `InvalidEvidenceNameError` (src/
   * context/errors.ts) for a `name` containing a path separator or equal to
   * `"."`/`".."`/`""`, and `ReservedEvidenceNameError` for a harness file
   * name (`record.json`, `final.png`, `trace.zip`, `http.jsonl`, any case):
   * refused, never silently rewritten. Capped at 100
   * attachments per execution, the true total reported on
   * `truncated.evidence` once that cap is hit, the same sibling-field
   * convention `truncated.actions` already uses. */
  readonly evidence: {
    readonly attach: (name: string, body: string | Uint8Array) => Promise<void>;
    readonly path: (name: string) => string;
  };
}

/** What a step receives when it destructures `scratch`. */
export interface Scratch {
  /** Creates an empty directory under the OS temporary directory and
   * returns its absolute path. `prefix` starts the directory name; omit it
   * for `"nukadoko-scratch"`. A prefix that holds a path separator throws:
   * the directory is always created directly under the temporary
   * directory. */
  dir(prefix?: string): string;
  /** Copies `source` (a directory or a file; a relative path resolves
   * against the project root) into a new directory from `dir()` and returns
   * that directory's absolute path. A directory's contents land at the top of
   * the new directory; a file lands in it under its own name. */
  copy(source: string): Promise<string>;
}

/** Builtins a project may replace with a fixture of its own shape.
 *
 * Kept out of `StepFixtures` on purpose. A project types its own fixture
 * by augmenting `StepFixtures` (`declare module "nukadoko"`), and
 * TypeScript refuses a second declaration of a property with a different
 * type (TS2717). Projects already declared their own `scratch` that way
 * before this builtin existed, with a narrower shape, so a `scratch` member
 * on `StepFixtures` would stop them compiling. `FixtureBag` below lets the
 * project's declaration win instead, which is also what happens at run
 * time: a `config.fixtures` entry with a builtin's name replaces it. */
export interface ReplaceableFixtures {
  /** Temporary directories, removed when the scenario ends, pass or fail
   * (src/context/scratch.ts). */
  readonly scratch: Scratch;
}

/** What a step's `run` receives: `StepFixtures`, plus each replaceable
 * builtin the project did not declare under the same name. */
export type FixtureBag = StepFixtures & Omit<ReplaceableFixtures, keyof StepFixtures>;

/** Every name `FixtureBag` carries, kept in sync with it by
 * construction rather than by hand: the object literal below is typed as
 * `Record<keyof FixtureBag, true>`, so a member
 * added to (or removed from) `StepFixtures` without a matching edit here
 * fails to compile. This is the one, closed set src/fixture/validate-
 * fixtures.ts checks a step's own destructured names against, and the one
 * src/context/create-context.ts's `buildStepFixtures` switches over to
 * build the bag. A fixture name has to be in this set to be something a
 * step can demand, so a name missing here cannot still type-check. */
const FIXTURE_NAME_MEMBERSHIP: Record<keyof FixtureBag, true> = {
  page: true,
  context: true,
  pageAs: true,
  request: true,
  env: true,
  requireEnv: true,
  baseURL: true,
  resultOf: true,
  section: true,
  poll: true,
  call: true,
  evidence: true,
  scratch: true,
};

export const BUILTIN_FIXTURE_NAMES: readonly string[] = Object.keys(FIXTURE_NAME_MEMBERSHIP);

/** The builtins that can open a browser: `needs_browser`, `playwright-missing`,
 * and `page-override-unowned` all read this one set,
 * so a new browser builtin cannot reach one of them and miss another. */
export const BROWSER_FIXTURE_NAMES: ReadonlySet<string> = new Set<keyof FixtureBag>(["page", "context", "pageAs"]);

export interface StepContext {
  /** Playwright Page; browser launches on first call, in a fresh context
   * built from `config.browserContext`, with the world's base URL wired into the
   * browser context so `page.goto("/path")` resolves against it. */
  page(): Promise<Page>;
  /** The same function as `StepFixtures.pageAs`; see its doc comment. */
  pageAs(name: string, options?: BrowserContextOptions): Promise<Page>;
  /** Playwright APIRequestContext with the world's base URL, built from `config.requestContext`. */
  request(): Promise<APIRequestContext>;
  /** Environment variables from the configured envFiles, then the world's
   * `env` from nukadoko.program.ts. A frozen copy of
   * the merged map: assigning a property throws in a step module, so a
   * write in one step is not visible to a later step or a later scenario.
   * A configured key still reads back as the loaded value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a required env var: same source as `ctx.env[name]`, minus the
   * presence check every step calling `ctx.env[name]` ended up writing for
   * itself (real migrations kept re-deriving the same `need()` helper, with
   * a different error message each time). Throws
   * `MissingEnvError` (src/context/errors.ts) when `name` is unset *or* set
   * to the empty string — an envFile's `KEY=` line sets no value, so an
   * empty string is treated as "not set", not as a deliberately-chosen empty
   * value (see `MissingEnvError`'s own doc comment for why). Returns
   * `string`, never `undefined`: the whole point is not needing an
   * `if (!value) throw` at every call site. */
  requireEnv(name: string): string;
  /** The world's base URL; see `StepFixtures.baseURL`. */
  readonly baseURL: string | undefined;
  /** The validated `result` of `step`'s most recent successful execution in
   * the current scenario, matched by the Step object's own identity — not
   * by name (docs/spec.md "Context API"). `undefined` under `nuka do`, or
   * when `step` hasn't succeeded yet in this scenario; a step that failed
   * never becomes readable, since only a
   * validated (`returns`-schema-passing) result ever enters the chain. Every
   * read that returns a value is measured: the executor records it as
   * provenance on this execution's own step record (`used`), so the dependency
   * is visible twice — as a static `import` of `step`, and at run time in
   * the step record chain (docs/spec.md "Records"). */
  resultOf<S extends Step>(step: S): z.infer<S["returns"]> | undefined;
  /** Marks that execution has reached stage `label`. Synchronous and void:
   * there is no matching "end" call and
   * no return value, so calling it costs nothing to place before an
   * `await`, inside a loop, or right before a step throws. Every call is
   * appended, in call order, to this execution's step record under
   * `sections`; a step that never calls it gets no `sections` key at all
   * (empty is omitted, the same convention `used` already follows). */
  section(label: string): void;
  /** Waits for `fn` to return a defined value, retrying at
   * `options.interval` (default 500ms) until `options.timeout` (default
   * 30_000ms). That timeout is a budget for the whole call, including the
   * attempt in flight: an attempt that has not settled when the budget ends
   * throws `PollTimeoutError` (src/context/poll.ts), and a value that
   * arrives later is not returned. A non-finite or non-positive `timeout`
   * or `interval` throws `InvalidPollOptionsError` before the first attempt.
   * `fn`'s own throw propagates unchanged. Every completed call —
   * resolved, timed out, or `fn` itself threw — is recorded on this
   * execution's step record under `polls` (docs/spec.md "Records"): how many
   * attempts it took, how long it waited, and how it ended. */
  poll<T>(fn: () => Promise<T | undefined>, options?: PollOptions): Promise<T>;
  /** The same fixture as `StepFixtures.call` above, reached the older,
   * function-based way every other member of this interface is — see that
   * member's own doc comment for the full contract. */
  call<S extends RunStep>(part: S, args: z.input<S["args"]>): Promise<z.infer<S["returns"]>>;
  /** The application-specific evidence fixture — see
   * `StepFixtures.evidence`'s own doc comment above for the full contract;
   * this is the same object, reached the older, function-based way every
   * other member of this interface is. */
  readonly evidence: {
    readonly attach: (name: string, body: string | Uint8Array) => Promise<void>;
    readonly path: (name: string) => string;
  };
  /** The same object as `FixtureBag.scratch`. */
  readonly scratch: Scratch;
}
