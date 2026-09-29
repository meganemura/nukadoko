import type { StepContext, StepFixtures } from "../step/context.js";
import { buildStepFixtures } from "../context/create-context.js";
import { closeFixtureNames, resolveDependencyEdge, type FixtureGraph, type FixtureNode } from "./graph.js";
import { startFixture, type FixtureInstance } from "./lifecycle.js";

export type { FixtureInstance };
import type { FixtureScope, FixtureUsageEntry } from "../record/types.js";
import type { FixtureDeps, FixtureOutcome } from "../step/fixture-types.js";

// Responsibility: the *runtime* counterpart to src/fixture/graph.ts's
// structural judgments — actually building a step's own
// requested fixture bag through the graph, and
// tearing a scope's own built fixtures down again, LIFO, once that scope's
// own lifetime ends. Everything here trusts its input is already validated
// (src/fixture/validate-fixtures.ts, run before execution in `nuka run`/`nuka
// do`'s own setup phase, same trust boundary src/context/create-
// context.ts's `buildStepFixtures` already documents for itself) — an
// unknown name or a cycle reaching this module throws plainly rather than
// looping or silently building a partial bag (src/fixture/graph.ts's own
// `closeFixtureNames`).
//
// A `FixtureCache` is the one piece of state this module owns: one per
// scope-lifetime (a fresh one per pickle for `"scenario"` scope, one shared
// across a whole `nuka run` invocation for `"process"` scope — `nuka do`
// creates one of each, both discarded after that single execution).
// `resolveFixtures` below is the one place both caches are read from and
// written to; nothing else in this package touches a `FixtureCache`'s own
// entries directly.
//
// **Builtin resolution never changes**: `buildStepFixtures` (src/context/
// create-context.ts, unmodified) still resolves every builtin name this
// closure needs, in one call, off whichever `ctx` the caller is currently
// executing under — including for a `"process"`-scope fixture being built
// lazily during some later scenario's own `ctx`, which is safe precisely
// because `findFixtureScopeViolations` (src/fixture/graph.ts) already
// refused any `"process"`-scope fixture that depends on anything but `env`/
// `requireEnv`/`baseURL` (scenario-independent values) before execution
// ever began.

export interface FixtureTeardownError {
  readonly fixture: string;
  readonly message: string;
}

export interface CachedFixture {
  readonly node: FixtureNode;
  readonly instance: FixtureInstance;
  readonly builtOrder: number;
}

/** One scope's own worth of already-built fixture instances — see this
 * file's own header for who creates one and for how long. Never read or
 * mutated directly outside this module. */
export interface FixtureCache {
  readonly entries: Map<string, CachedFixture>;
  nextOrder: number;
}

export function createFixtureCache(): FixtureCache {
  return { entries: new Map(), nextOrder: 0 };
}

async function getOrBuild(
  cache: FixtureCache,
  name: string,
  node: FixtureNode,
  deps: FixtureDeps,
  timeoutMs: number,
): Promise<{ readonly value: unknown; readonly reused: boolean; readonly setupMs?: number; readonly at?: string }> {
  const existing = cache.entries.get(name);
  if (existing !== undefined) {
    return { value: existing.instance.value, reused: true };
  }
  const startedAt = new Date();
  const startedPerf = performance.now();
  // `node.run` is always set here: `cache`/`getOrBuild` are only ever
  // reached for a name in `closure.userOrder` (src/fixture/graph.ts's
  // `closeFixtureNames`), which only ever contains non-builtin nodes.
  const instance = await startFixture(name, node.run!, deps, timeoutMs);
  const setupMs = Math.round(performance.now() - startedPerf);
  cache.entries.set(name, { node, instance, builtOrder: cache.nextOrder });
  cache.nextOrder += 1;
  return { value: instance.value, reused: false, setupMs, at: startedAt.toISOString() };
}

export interface ResolveFixturesOptions {
  /** The fixture names one step's own `run()` destructures — the same list
   * src/step/fixture-names.ts's `fixtureParameterNames(step.run)` already
   * produces. */
  readonly names: readonly string[];
  readonly graph: FixtureGraph;
  /** This step's own executing `ctx` — where every builtin name this
   * closure needs is actually resolved from (this file's own header). */
  readonly ctx: StepContext;
  readonly scenarioCache: FixtureCache;
  readonly processCache: FixtureCache;
  /** `config.fixtureTimeout` — the default every fixture instance's own
   * `options.timeout` (if any) overrides. */
  readonly defaultTimeoutMs: number;
}

/**
 * Resolves `names` into the exact bag a step's own `run(fixtures, args)`
 * receives — builtins (possibly overridden) resolved through the existing
 * `buildStepFixtures`, `config.fixtures` entries built (or reused from
 * whichever cache their own `scope` selects) in topological order, each
 * one's own `deps` built from its *resolved* dependency values (an
 * override's self-reference reads the builtin, per src/fixture/graph.ts's
 * own `resolveDependencyEdge`; every other consumer reads whichever value
 * is current — the override's, once built). `fixtures` only ever carries
 * the keys in `names` itself (a step never receives a fixture it did not
 * itself destructure, even one it transitively caused to be built) — see
 * src/context/create-context.ts's own `buildStepFixtures` for the builtin
 * half of that same rule.
 */
export async function resolveFixtures(
  options: ResolveFixturesOptions,
): Promise<{ readonly fixtures: StepFixtures; readonly usage: FixtureUsageEntry[] }> {
  const { names, graph, ctx, scenarioCache, processCache, defaultTimeoutMs } = options;
  const closure = closeFixtureNames(names, graph);

  const builtinValues = (await buildStepFixtures(ctx, closure.builtinNames)) as unknown as Record<string, unknown>;
  const resolvedValues: Record<string, unknown> = { ...builtinValues };
  const usage: FixtureUsageEntry[] = [];

  for (const name of closure.userOrder) {
    const node = graph.nodes.get(name)!;
    const deps: Record<string, unknown> = {};
    for (const dep of node.dependencies) {
      const edge = resolveDependencyEdge(node, dep, graph);
      if (edge.kind === "builtin") {
        deps[dep] = builtinValues[edge.name];
      } else if (edge.kind === "user") {
        deps[dep] = resolvedValues[edge.name];
      }
      // "unknown" is defense-in-depth-only here — pre-validated.
    }

    const timeoutMs = node.timeoutMs ?? defaultTimeoutMs;
    const cache = node.scope === "process" ? processCache : scenarioCache;
    const built = await getOrBuild(cache, name, node, deps as FixtureDeps, timeoutMs);
    resolvedValues[name] = built.value;
    usage.push({
      name,
      scope: node.scope,
      reused: built.reused,
      ...(built.setupMs !== undefined ? { setup_ms: built.setupMs } : {}),
      ...(built.at !== undefined ? { at: built.at } : {}),
    });
  }

  const fixtures: Record<string, unknown> = {};
  for (const name of names) {
    fixtures[name] = resolvedValues[name];
  }
  return { fixtures: fixtures as unknown as StepFixtures, usage };
}

/**
 * Tears down every fixture instance currently in `cache`, in reverse build
 * order — folding teardown over the exact
 * reverse of construction order only guarantees every dependency outlives
 * its own dependents because nukadoko runs everything in this cache's own
 * scope *serially*; the day any of it parallelizes, this ordering guarantee
 * breaks silently and this function has to change first. Never throws: each
 * instance's own `teardown()` already turns a failure into a returned
 * message rather than a rejection (src/fixture/
 * lifecycle.ts), so one fixture's broken teardown can never stop a
 * sibling's from running, and never changes the step's/scenario's own
 * outcome either. Empties `cache` afterward — a cache is torn down exactly
 * once in its own lifetime.
 */
export async function teardownFixtureCache(
  cache: FixtureCache,
  outcome: FixtureOutcome,
): Promise<FixtureTeardownError[]> {
  const entries = [...cache.entries.entries()].sort((a, b) => b[1].builtOrder - a[1].builtOrder);
  const errors: FixtureTeardownError[] = [];
  for (const [name, cached] of entries) {
    const message = await cached.instance.teardown(outcome);
    if (message !== undefined) {
      errors.push({ fixture: name, message });
    }
  }
  cache.entries.clear();
  return errors;
}
