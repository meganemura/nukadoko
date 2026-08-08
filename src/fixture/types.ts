import type { StepFixtures } from "../context.js";

// Responsibility: the *types* a user-defined fixture is shaped by (P5 task
// spec, scope items 1-2) — no execution logic here (src/fixture/lifecycle.ts
// owns the setup/teardown coroutine, src/fixture/graph.ts owns dependency/
// scope analysis, src/fixture/resolver.ts owns caching + the per-step entry
// point) and no config parsing (src/config/schema.ts imports
// `FixtureDefinition` from here, never the reverse — this file has no
// dependency on zod or on the config module at all, the same "types have no
// business knowing how they get validated" split defineConfig/schema.ts
// already keep). Also home to `defineFixtures()` (define-fixtures.ts, a
// separate file for the same reason `src/config/define-config.ts` is split
// from `src/config/schema.ts`).
//
// `UseFn` is deliberately *not* parameterized by a map of every fixture
// name to its own value type the way Playwright's own `Fixtures<T, W, ...>`
// is — the same contextual-typing limit that forces `defineFixtures` to
// exist at all (define-fixtures.ts's own header: `base.extend()`-style
// inference only works on an inline object literal, not one exported to a
// variable first). Measured against this project's own TypeScript version
// while designing this file: making a fixture's `deps` parameter type
// depend on a self-referencing generic inferred from the very
// `defineFixtures({...})` call it appears in
// only actually infers real per-key types once at least one entry in that
// same call happens to use the tuple form (`[fn, options]`) — an
// undocumented compiler quirk (a bare-function-only object literal, with no
// tuple anywhere in the same call, falls back to `T = Record<string,
// unknown>` for every entry, silently), not a rule a config author should
// have to know just to get real typing on a single fixture. `use` is
// therefore a plain *generic function* (`<V>(value: V) => ...`), whose
// argument type TypeScript infers the ordinary way, at each call site, with
// no help needed from the surrounding object literal at all; `deps` is one
// single, fixed, non-generic shape every fixture destructures from the same
// "known builtins, `unknown` for anything else" way.
//
// The trade this makes: a fixture that depends on *another user-defined*
// fixture destructures a real name (validated at check/run/do time against
// `config.fixtures`, exactly the way a step's own destructuring already is
// — src/step/validate-fixtures.ts), but its value types as `unknown` rather
// than that other fixture's own declared value type. Losing that one
// cross-reference is what buys "every legitimate `defineFixtures({...})`
// compiles under `strict`, with no implicit `any`" — the actual, narrower
// promise this task's spec makes ("素の `export const fixtures = {...}` で
// は型が壊れる" is the failure this exists to fix, not full Playwright-style
// fixture-to-fixture type inference, which this package's own "前提" already
// says Playwright's runtime cannot be borrowed to get for free).

/** Passed to whatever `use()`'s own promise resolves with, once the step
 * (or, for `scope: "process"`, the process itself) that named this fixture
 * has finished — a fixture's only way to know whether to keep what it built
 * or discard it. Never available at setup time: an outcome doesn't exist
 * yet when `use()` is first called, only once whatever named this fixture
 * is itself done — see `UseFn`'s own doc comment for why this is the
 * *return* value of `use()`, not a second argument to the fixture
 * function. */
export type FixtureOutcome = "passed" | "failed";

/**
 * `use(value)` hands `value` to whatever named this fixture and suspends
 * the fixture function until that step (or, for `scope: "process"`, the
 * process itself) has finished — the same await-a-continuation shape Playwright's
 * own fixtures use, reimplemented here (src/fixture/lifecycle.ts) since
 * Playwright's own fixture runtime cannot be borrowed (this task's spec,
 * "前提": `Symbol(testType)` is not `Symbol.for`, and `lib/worker/*` is
 * blocked by `exports`). Resolves to the outcome once the caller decides
 * teardown may proceed — never before, and never left unresolved: a
 * `use()` call that never resolves would leave a fixture's own `await
 * use(...)` line hanging forever, which is exactly the class of bug src/
 * fixture/lifecycle.ts's own timeout turns into a named failure instead
 * (this task's spec, item 7).
 *
 * Generic per call (`<V>`), not tied to any outer map of fixture names to
 * value types — see this file's own header for why. */
export type UseFn = <V>(value: V) => Promise<FixtureOutcome>;

/** What every fixture function's own first argument destructures from —
 * every builtin `StepFixtures` member, typed exactly the way a step's own
 * `run` sees them (so `{ request }`, `{ page }`, etc. are fully typed),
 * plus an index signature covering any other name (another user-defined
 * fixture, read by name) this type cannot know about without the
 * self-referencing inference this file's own header explains nukadoko does
 * not attempt. */
export type FixtureDeps = StepFixtures & Record<string, unknown>;

/** One fixture's own setup+teardown function — always async in practice
 * (an `await use(...)` sits inside), typed to also allow a synchronous
 * `void` return only because TypeScript cannot otherwise tell such a
 * function apart from one that simply forgot to return a promise; src/
 * fixture/lifecycle.ts always `await`s whatever comes back either way. */
export type FixtureFn = (deps: FixtureDeps, use: UseFn) => Promise<void> | void;

/** `"scenario"` (default) rebuilds per scenario (or per `nuka do`
 * execution) and tears down at that scenario's own end; `"process"` builds
 * once — the first time any step in the whole `nuka run` invocation names
 * it (or its own dependents do) — and tears down once, after every
 * scenario has finished. Under `nuka do` the two collapse to the same
 * single-execution lifetime (this task's spec, scope item 3).
 *
 * `"worker"` is deliberately not a member: there is no parallel execution
 * yet, so it would be a synonym for `"process"` with none of the meaning a
 * name should only be spent on once that distinction actually exists (same
 * spec section: "無い物の名前を先に取ると意味が固まる前に固まる").
 *
 * `"process"` names one address space, not one `nuka run` invocation
 * (p8-scope-rename task spec): a fixture's own value is a plain JS object
 * and cannot cross into another process, so this scope can only ever mean
 * "once per process" no matter how many times anything is invoked against
 * it. Today one `nuka run` invocation is one process, so the two happen to
 * coincide, but that coincidence is not a guarantee this scope makes.
 * Something that has to happen exactly once in the world, no matter how
 * many processes ever run against it — seeding a database, running a
 * migration, starting a mock server that owns a port — does not belong in
 * a `"process"`-scope fixture: run more than one process and it happens
 * again. */
export type FixtureScope = "scenario" | "process";

export interface FixtureOptions {
  readonly scope?: FixtureScope;
  /** Overrides `config.fixtureTimeout` for this one fixture's own setup
   * *and* teardown (milliseconds, each phase gets its own full budget) —
   * see src/fixture/lifecycle.ts. */
  readonly timeout?: number;
}

/** The shape a `nukadoko.config.ts`'s `fixtures.<name>` entry takes —
 * deliberately the same shape (a bare function, or a `[function, options]`
 * tuple) Playwright's own fixture definitions take (this task's spec,
 * scope item 1), so a config author who also shares a fixture with
 * `base.extend()` — only when its own dependencies stay inside `page`/
 * `context`/`request`/`baseURL`, docs/spec.md's own fixtures section
 * explains the boundary — can pass the identical object literal to both,
 * without this package claiming any deeper "Playwright fixture
 * compatible" than that one shape (`auto: true` is refused outright,
 * precisely because accepting it would be the first claim this package
 * does not keep — src/config/schema.ts). */
export type FixtureDefinition = FixtureFn | readonly [FixtureFn, FixtureOptions];

/** `true` when `definition` is the `[function, options]` tuple form,
 * narrowing accordingly — the one place both halves of `FixtureDefinition`
 * are told apart, so `fixtureFnOf`/`fixtureOptionsOf` below (and any future
 * caller) never re-derive the same `Array.isArray` check by hand. */
export function isFixtureTuple(
  definition: FixtureDefinition,
): definition is readonly [FixtureFn, FixtureOptions] {
  return Array.isArray(definition);
}

/** `definition`'s own function, whichever of the two shapes it was
 * written in. */
export function fixtureFnOf(definition: FixtureDefinition): FixtureFn {
  return isFixtureTuple(definition) ? definition[0] : definition;
}

/** `definition`'s own options, `{}` for the bare-function shape (every
 * option's own default — `scope: "scenario"`, `timeout` falling back to
 * `config.fixtureTimeout` — applies identically whether a fixture ever
 * wrote a tuple at all). */
export function fixtureOptionsOf(definition: FixtureDefinition): FixtureOptions {
  return isFixtureTuple(definition) ? definition[1] : {};
}
