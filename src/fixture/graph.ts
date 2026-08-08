import type { NukadokoConfig } from "../config/schema.js";
import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import { fixtureParameterNames } from "../step/fixture-names.js";
import { fixtureFnOf, fixtureOptionsOf, type FixtureFn, type FixtureScope } from "./types.js";

// Responsibility: the fixture *dependency graph* — layering builtin and
// `config.fixtures` names into one structure,
// and every purely structural judgment over it that does not need to
// actually run anything: which name a dependency edge resolves to (honoring
// "a same-named override depends on the previous layer, not on itself"), a
// cycle, a `process`-scope fixture depending on a `scenario`-scope one,
// `page` overridden by a fixture that owns neither `page` nor `context`,
// and the reachable subgraph + build order a step's own requested names
// close over. src/step/
// validate-fixtures.ts turns this module's findings into the `FixtureIssue`/
// `FixtureDefinitionIssue` shape `nuka check`/`nuka run`/`nuka do` already
// share; src/fixture/resolver.ts is the only caller that actually builds
// anything, using `closeFixtureNames`/`resolveDependencyEdge` from here to
// decide what to build and in what order, never re-deriving either.
//
// **This module never calls a fixture function.** Every judgment here reads
// a fixture's own declared dependency *names* (`fixtureParameterNames`,
// src/step/fixture-names.ts — the same `fn.toString()` parse a step's own
// destructuring already goes through) — never its body: running one could
// launch a browser or make a network call before a `run` has even begun,
// which is exactly what a check meant to decide things *before* execution
// must not do, matching this project's own "check never executes a
// fixture" rule.
//
// The override rule (Playwright's own `extend()` semantics, deliberately
// mirrored): a fixture defined under `config.fixtures` with the same name
// as a builtin (`page`, `context`, ...) *replaces* that builtin for every
// other consumer, but its own destructured dependency on that same name
// resolves to the builtin it is overriding, not to itself — otherwise
// every legitimate `page: async ({ page }, use) => {...}` would read as a
// one-node self-cycle. `resolveDependencyEdge` below is the one place that
// distinction is made; every other function in this file and in src/
// fixture/resolver.ts goes through it rather than re-deriving the rule.

/** One name in the graph — a builtin (`isBuiltin: true`, no `run`/
 * `timeoutMs` of its own, `dependencies: []`: builtins are always leaves
 * from this graph's point of view, resolved by src/context/create-
 * context.ts's `buildStepFixtures`, never by src/fixture/lifecycle.ts) or a
 * `config.fixtures` entry. `dependencies` is the raw list
 * `fixtureParameterNames` read off the fixture's own function — not yet
 * resolved to builtin/user/unknown, see `resolveDependencyEdge`. */
export interface FixtureNode {
  readonly name: string;
  readonly isBuiltin: boolean;
  readonly scope: FixtureScope;
  readonly timeoutMs?: number;
  readonly run?: FixtureFn;
  readonly dependencies: readonly string[];
}

export interface FixtureGraph {
  /** Every builtin's own node, keyed by name — *never* shadowed by a
   * user override, unlike `nodes` below. This is what a same-named
   * override's own self-reference resolves to (the "previous layer"),
   * and what `edgeScope` reads a builtin dependency's scope from. */
  readonly builtins: ReadonlyMap<string, FixtureNode>;
  /** Builtins ∪ `config.fixtures` — a user override *replaces* the
   * same-named builtin entry here, so every consumer other than the
   * override's own self-reference sees the override (Playwright's own
   * layering, this file's own header). */
  readonly nodes: ReadonlyMap<string, FixtureNode>;
}

/** `page`/`context`/`request`/`resultOf`/`section`/`poll`/`evidence` all
 * need this run's *current scenario's* `ctx` to build (a browser, a request
 * context, this scenario's own result chain, this step's own moving
 * evidence directory) — a `process`-scope fixture, built once
 * before any one scenario's own resources are guaranteed to still exist by
 * the time a later scenario tears them down, must never depend on one of
 * these (`findFixtureScopeViolations` below). `env`/`requireEnv`/`baseURL`
 * are the same values regardless of which scenario's `ctx` happens to read
 * them off, so a `process`-scope fixture may depend on any of the three. */
const PROCESS_SAFE_BUILTIN_NAMES = new Set(["env", "requireEnv", "baseURL"]);

const BUILTIN_NAME_SET = new Set(BUILTIN_FIXTURE_NAMES);

export function isBuiltinFixtureName(name: string): boolean {
  return BUILTIN_NAME_SET.has(name);
}

function builtinScope(name: string): FixtureScope {
  return PROCESS_SAFE_BUILTIN_NAMES.has(name) ? "process" : "scenario";
}

/** Assembles the two-layer graph this file's own header describes —
 * `config.fixtures`' own dependency names are read once here (memoized by
 * `fixtureParameterNames` itself, so `nuka check` and `nuka run`/`nuka do`
 * sharing this same call never re-parse a fixture's source text twice). A
 * fixture whose own destructuring can't be read at all (not destructured, a
 * default value, a rest property) gets `dependencies: []` here rather than
 * throwing — that shape mistake is `validateFixtureDefinitions`'s own
 * finding (src/step/validate-fixtures.ts), reported once, in one place;
 * this function has to build *some* graph for every other fixture's own
 * checks to run against regardless of one broken entry. */
export function buildFixtureGraph(config: Pick<NukadokoConfig, "fixtures">): FixtureGraph {
  const builtins = new Map<string, FixtureNode>();
  for (const name of BUILTIN_FIXTURE_NAMES) {
    builtins.set(name, { name, isBuiltin: true, scope: builtinScope(name), dependencies: [] });
  }

  const nodes = new Map<string, FixtureNode>(builtins);
  for (const [name, definition] of Object.entries(config.fixtures)) {
    const fn = fixtureFnOf(definition);
    const options = fixtureOptionsOf(definition);
    let dependencies: readonly string[];
    try {
      dependencies = fixtureParameterNames(fn);
    } catch {
      dependencies = [];
    }
    nodes.set(name, {
      name,
      isBuiltin: false,
      scope: options.scope ?? "scenario",
      ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      run: fn,
      dependencies,
    });
  }

  return { builtins, nodes };
}

export type FixtureEdgeTarget =
  | { readonly kind: "builtin"; readonly name: string }
  | { readonly kind: "user"; readonly name: string }
  | { readonly kind: "unknown"; readonly name: string };

/**
 * What `node`'s own destructured dependency `depName` actually refers to —
 * the one place the override rule (this file's own header) is applied.
 *
 * - `depName === node.name` and a builtin of that name exists: resolves to
 *   that *builtin* — the "previous layer" a same-named override depends on,
 *   bypassing `graph.nodes.get(depName)` (which would otherwise return
 *   `node` itself again).
 * - Otherwise, whatever `graph.nodes.get(depName)` is — a builtin, a
 *   *different* user fixture, or (rare, but legitimate: a fixture with no
 *   builtin under its own name that destructures itself) `node` itself
 *   again, which is exactly a one-node cycle for `findFixtureCycles` to
 *   catch.
 * - `depName` unknown to both layers: `{ kind: "unknown" }` — reported by
 *   `validateFixtureDefinitions`'s own unknown-fixture check, not by any
 *   function in this file; every graph-shape function below simply skips
 *   an edge of this kind rather than duplicating that finding.
 */
export function resolveDependencyEdge(
  node: FixtureNode,
  depName: string,
  graph: FixtureGraph,
): FixtureEdgeTarget {
  if (depName === node.name && graph.builtins.has(depName)) {
    return { kind: "builtin", name: depName };
  }
  const depNode = graph.nodes.get(depName);
  if (depNode === undefined) {
    return { kind: "unknown", name: depName };
  }
  return depNode.isBuiltin ? { kind: "builtin", name: depName } : { kind: "user", name: depName };
}

/** One finding about a `config.fixtures` *definition* itself (as opposed
 * to `FixtureIssue` in src/step/validate-fixtures.ts, about a *step's own
 * usage* of one) — `nuka check`'s fixture-* codes. All three "guess zero":
 * each one is a fact about the graph's own
 * shape, decided without ever running a fixture. */
export interface FixtureDefinitionIssue {
  readonly code: "fixture-cycle" | "fixture-scope-violation" | "page-override-unowned";
  readonly fixture: string;
  readonly message: string;
}

/**
 * Every dependency cycle among `config.fixtures` entries — builtins are
 * always leaves (`dependencies: []`), so a cycle can only ever run through
 * `"user"` edges. Standard three-color DFS; a node already fully explored
 * (`BLACK`) is never re-entered, so the same cycle is reported once, from
 * whichever entry point's own traversal first closes it, not once per
 * fixture that happens to reach it.
 */
export function findFixtureCycles(graph: FixtureGraph): FixtureDefinitionIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const userNodes = [...graph.nodes.values()].filter((node) => !node.isBuiltin);
  for (const node of userNodes) {
    color.set(node.name, WHITE);
  }

  const issues: FixtureDefinitionIssue[] = [];

  function visit(name: string, stack: string[]): void {
    color.set(name, GRAY);
    stack.push(name);
    const node = graph.nodes.get(name);
    if (node !== undefined) {
      for (const dep of node.dependencies) {
        const edge = resolveDependencyEdge(node, dep, graph);
        if (edge.kind !== "user") {
          continue;
        }
        const depColor = color.get(edge.name);
        if (depColor === GRAY) {
          const startIndex = stack.indexOf(edge.name);
          const cycle = [...stack.slice(startIndex), edge.name];
          issues.push({
            code: "fixture-cycle",
            fixture: cycle[0]!,
            message: `fixture dependency cycle: ${cycle.join(" -> ")}`,
          });
        } else if (depColor === WHITE) {
          visit(edge.name, stack);
        }
      }
    }
    stack.pop();
    color.set(name, BLACK);
  }

  for (const node of userNodes) {
    if (color.get(node.name) === WHITE) {
      visit(node.name, []);
    }
  }

  return issues;
}

/** A `scope: "process"` fixture depending — directly or through a same-named
 * builtin self-reference — on anything `scope: "scenario"` (a scenario-only
 * builtin, or a `config.fixtures` entry that didn't set `scope: "process"`
 * itself). `env`/`requireEnv`/`baseURL` (`PROCESS_SAFE_BUILTIN_NAMES` above)
 * are the one builtin exception: their own value never depends on which
 * scenario's `ctx` happens to read them. */
export function findFixtureScopeViolations(graph: FixtureGraph): FixtureDefinitionIssue[] {
  const issues: FixtureDefinitionIssue[] = [];
  for (const node of graph.nodes.values()) {
    if (node.isBuiltin || node.scope !== "process") {
      continue;
    }
    for (const dep of node.dependencies) {
      const edge = resolveDependencyEdge(node, dep, graph);
      if (edge.kind === "unknown") {
        continue;
      }
      const depNode = edge.kind === "builtin" ? graph.builtins.get(edge.name) : graph.nodes.get(edge.name);
      if (depNode !== undefined && depNode.scope === "scenario") {
        issues.push({
          code: "fixture-scope-violation",
          fixture: node.name,
          message:
            `fixture "${node.name}" has scope "process" but depends on "${edge.name}", which is scope ` +
            '"scenario": a "process"-scope fixture is built once for the whole run and can outlive any single ' +
            'scenario\'s own resources, so it cannot depend on something rebuilt per scenario',
        });
      }
    }
  }
  return issues;
}

/** `page` overridden by a fixture that destructures neither `page` nor
 * `context` — there is no way for such an override to hand back a page the
 * executor still owns and measures (nothing it could construct on its own
 * traces back to the browser context nukadoko launched). Silent about every
 * other name: overriding `context`/`request`/anything else carries no such
 * "who owns measurement" risk. */
export function findPageOverrideUnowned(graph: FixtureGraph): FixtureDefinitionIssue[] {
  const override = graph.nodes.get("page");
  if (override === undefined || override.isBuiltin) {
    return [];
  }
  if (override.dependencies.includes("page") || override.dependencies.includes("context")) {
    return [];
  }
  return [
    {
      code: "page-override-unowned",
      fixture: "page",
      message:
        'fixture "page" overrides the builtin page but destructures neither "page" nor "context": there is ' +
        "no way for it to hand back a page the executor still owns and measures",
    },
  ];
}

/** `true` when `name` reaches `page`/`context`, directly or through a
 * chain of `config.fixtures` dependencies — `nuka steps --json`'s
 * `needs_browser` transitive closure and
 * `nuka tend`'s `fixture-touches-app` finding both read
 * this, never re-deriving the traversal. `visited` guards against a cycle
 * (defense in depth only — `findFixtureCycles` already refuses a cyclic
 * config before either caller runs). */
export function fixtureReachesBrowser(
  name: string,
  graph: FixtureGraph,
  visited: Set<string> = new Set(),
): boolean {
  if (name === "page" || name === "context") {
    return true;
  }
  if (visited.has(name)) {
    return false;
  }
  visited.add(name);
  const node = graph.nodes.get(name);
  if (node === undefined || node.isBuiltin) {
    return false;
  }
  for (const dep of node.dependencies) {
    const edge = resolveDependencyEdge(node, dep, graph);
    if (edge.kind === "builtin" && (edge.name === "page" || edge.name === "context")) {
      return true;
    }
    if (edge.kind === "user" && fixtureReachesBrowser(edge.name, graph, visited)) {
      return true;
    }
  }
  return false;
}

/** The reachable subgraph + build order `names` (a step's own destructured
 * fixture list) closes over — `builtinNames` is every builtin
 * (possibly overridden) this closure needs, resolved in one
 * `buildStepFixtures` call by src/fixture/resolver.ts; `userOrder` is every
 * `config.fixtures` entry this closure needs, dependencies-first, ready to
 * build in that exact order.
 *
 * Trusts `names`/`graph` are already known-good (`validateStepFixtures`/
 * `validateFixtureDefinitions`, run before execution in `nuka check`/`nuka
 * run`/`nuka do`'s own setup phase, same as src/context/create-context.ts's
 * `buildStepFixtures` already trusts its own input) — an unknown name or a
 * cycle reaching this function throws plainly rather than looping or
 * silently building a partial bag, the same "nothing breaks silently"
 * defense-in-depth `buildStepFixtures`'s own `default` branch already is.
 */
export function closeFixtureNames(
  names: readonly string[],
  graph: FixtureGraph,
): { readonly builtinNames: readonly string[]; readonly userOrder: readonly string[] } {
  const builtinNames = new Set<string>();
  const order: string[] = [];
  const done = new Set<string>();
  const inProgress = new Set<string>();

  function visit(name: string): void {
    if (done.has(name)) {
      return;
    }
    if (inProgress.has(name)) {
      throw new Error(
        `internal: fixture cycle involving "${name}" reached the resolver; ` +
          "src/step/validate-fixtures.ts's fixture-cycle check should have refused this before execution began",
      );
    }
    const node = graph.nodes.get(name);
    if (node === undefined) {
      throw new Error(
        `internal: unknown fixture "${name}" reached the resolver; ` +
          "src/step/validate-fixtures.ts should have refused this before execution began",
      );
    }
    if (node.isBuiltin) {
      builtinNames.add(name);
      done.add(name);
      return;
    }
    inProgress.add(name);
    for (const dep of node.dependencies) {
      const edge = resolveDependencyEdge(node, dep, graph);
      if (edge.kind === "builtin") {
        builtinNames.add(edge.name);
      } else if (edge.kind === "user") {
        visit(edge.name);
      }
      // "unknown" is defense-in-depth-only here too — pre-validated.
    }
    inProgress.delete(name);
    done.add(name);
    order.push(name);
  }

  for (const name of names) {
    visit(name);
  }

  return { builtinNames: [...builtinNames], userOrder: order };
}
