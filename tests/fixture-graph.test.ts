import { describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import {
  buildFixtureGraph,
  closeFixtureNames,
  findFixtureCycles,
  findFixtureScopeViolations,
  findPageOverrideUnowned,
  fixtureReachesBrowser,
  resolveDependencyEdge,
} from "../src/fixture/graph.js";
import type { FixtureDefinition } from "../src/fixture/types.js";

// Responsibility: unit tests for src/fixture/graph.ts — the purely
// structural half of P5 (layering, the same-name-override rule, cycle/
// scope-violation/page-override-unowned detection, and the closure/build-
// order a step's own requested names produce). No config loading, no
// discovery, no execution: every fixture function below is a plain arrow
// function whose body is never called (this module only ever reads
// `fn.toString()`), mirroring tests/validate-fixtures.test.ts's own
// "exercise the runtime judgment directly" shape.

function configWithFixtures(fixtures: Record<string, FixtureDefinition>): Pick<NukadokoConfig, "fixtures"> {
  return { fixtures };
}

describe("buildFixtureGraph", () => {
  it("includes every builtin as a leaf, scenario-scoped except env/requireEnv/baseURL", () => {
    const graph = buildFixtureGraph(configWithFixtures({}));
    expect(graph.nodes.get("page")).toMatchObject({ isBuiltin: true, scope: "scenario", dependencies: [] });
    expect(graph.nodes.get("context")).toMatchObject({ isBuiltin: true, scope: "scenario" });
    expect(graph.nodes.get("request")).toMatchObject({ isBuiltin: true, scope: "scenario" });
    expect(graph.nodes.get("resultOf")).toMatchObject({ isBuiltin: true, scope: "scenario" });
    expect(graph.nodes.get("section")).toMatchObject({ isBuiltin: true, scope: "scenario" });
    expect(graph.nodes.get("poll")).toMatchObject({ isBuiltin: true, scope: "scenario" });
    expect(graph.nodes.get("env")).toMatchObject({ isBuiltin: true, scope: "process" });
    expect(graph.nodes.get("requireEnv")).toMatchObject({ isBuiltin: true, scope: "process" });
    expect(graph.nodes.get("baseURL")).toMatchObject({ isBuiltin: true, scope: "process" });
  });

  it("adds a user fixture, scope defaulting to scenario", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({ id: "t1" });
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    const node = graph.nodes.get("tenant");
    expect(node).toMatchObject({ isBuiltin: false, scope: "scenario", dependencies: ["request"] });
  });

  it("reads scope/timeout from the [fn, options] tuple form", () => {
    const seededDb: FixtureDefinition = [
      async ({}, use) => {
        await use(42);
      },
      { scope: "process", timeout: 5_000 },
    ];
    const graph = buildFixtureGraph(configWithFixtures({ seededDb }));
    expect(graph.nodes.get("seededDb")).toMatchObject({ scope: "process", timeoutMs: 5_000, dependencies: [] });
  });

  it("a same-named entry overrides the builtin in `nodes`, but `builtins` keeps the raw one", () => {
    const pageOverride: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    expect(graph.nodes.get("page")).toMatchObject({ isBuiltin: false });
    expect(graph.builtins.get("page")).toMatchObject({ isBuiltin: true });
  });
});

describe("resolveDependencyEdge", () => {
  it("resolves a same-named override's own self-reference to the builtin, not itself", () => {
    const pageOverride: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    const node = graph.nodes.get("page")!;
    expect(resolveDependencyEdge(node, "page", graph)).toEqual({ kind: "builtin", name: "page" });
  });

  it("resolves an unrelated builtin dependency to kind: builtin", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    const node = graph.nodes.get("tenant")!;
    expect(resolveDependencyEdge(node, "request", graph)).toEqual({ kind: "builtin", name: "request" });
  });

  it("resolves a dependency on a different user fixture to kind: user", () => {
    const a: FixtureDefinition = async ({}, use) => {
      await use(1);
    };
    const b: FixtureDefinition = async ({ a: aValue }, use) => {
      void aValue;
      await use(2);
    };
    const graph = buildFixtureGraph(configWithFixtures({ a, b }));
    const node = graph.nodes.get("b")!;
    expect(resolveDependencyEdge(node, "a", graph)).toEqual({ kind: "user", name: "a" });
  });

  it("resolves an unknown name to kind: unknown", () => {
    const a: FixtureDefinition = async ({ bogus }: any, use) => {
      void bogus;
      await use(1);
    };
    const graph = buildFixtureGraph(configWithFixtures({ a }));
    const node = graph.nodes.get("a")!;
    expect(resolveDependencyEdge(node, "bogus", graph)).toEqual({ kind: "unknown", name: "bogus" });
  });

  it("a self-reference with no builtin of the same name resolves to itself (a real cycle)", () => {
    const selfCyclic: FixtureDefinition = async ({ selfCyclic: self }: any, use) => {
      void self;
      await use(1);
    };
    const graph = buildFixtureGraph(configWithFixtures({ selfCyclic }));
    const node = graph.nodes.get("selfCyclic")!;
    expect(resolveDependencyEdge(node, "selfCyclic", graph)).toEqual({ kind: "user", name: "selfCyclic" });
  });
});

describe("findFixtureCycles", () => {
  it("finds a two-node cycle (a -> b -> a)", () => {
    const a: FixtureDefinition = async ({ b }: any, use) => {
      void b;
      await use(1);
    };
    const b: FixtureDefinition = async ({ a: aValue }: any, use) => {
      void aValue;
      await use(2);
    };
    const graph = buildFixtureGraph(configWithFixtures({ a, b }));
    const issues = findFixtureCycles(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("fixture-cycle");
    expect(issues[0]?.message).toMatch(/a -> b -> a/);
  });

  it("finds a one-node self-cycle", () => {
    const selfCyclic: FixtureDefinition = async ({ selfCyclic: self }: any, use) => {
      void self;
      await use(1);
    };
    const graph = buildFixtureGraph(configWithFixtures({ selfCyclic }));
    const issues = findFixtureCycles(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fixture).toBe("selfCyclic");
  });

  it("does not flag a same-named builtin override as a cycle", () => {
    const pageOverride: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    expect(findFixtureCycles(graph)).toEqual([]);
  });

  it("returns [] for an acyclic graph", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    expect(findFixtureCycles(graph)).toEqual([]);
  });
});

describe("findFixtureScopeViolations", () => {
  it("flags a process-scope fixture depending on a scenario-scope builtin (page)", () => {
    const seededDb: FixtureDefinition = [
      async ({ page }: any, use) => {
        void page;
        await use(1);
      },
      { scope: "process" },
    ];
    const graph = buildFixtureGraph(configWithFixtures({ seededDb }));
    const issues = findFixtureScopeViolations(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "fixture-scope-violation", fixture: "seededDb" });
    expect(issues[0]?.message).toContain("page");
  });

  it("flags a process-scope fixture depending on a scenario-scope user fixture", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({});
    };
    const seededDb: FixtureDefinition = [
      async ({ tenant: t }: any, use) => {
        void t;
        await use(1);
      },
      { scope: "process" },
    ];
    const graph = buildFixtureGraph(configWithFixtures({ tenant, seededDb }));
    const issues = findFixtureScopeViolations(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fixture).toBe("seededDb");
  });

  it("allows a process-scope fixture to depend on env/requireEnv/baseURL", () => {
    const seededDb: FixtureDefinition = [
      async ({ env, requireEnv, baseURL }, use) => {
        void env;
        void requireEnv;
        void baseURL;
        await use(1);
      },
      { scope: "process" },
    ];
    const graph = buildFixtureGraph(configWithFixtures({ seededDb }));
    expect(findFixtureScopeViolations(graph)).toEqual([]);
  });

  it("allows a process-scope fixture to depend on another process-scope fixture", () => {
    const a: FixtureDefinition = [
      async ({}, use) => {
        await use(1);
      },
      { scope: "process" },
    ];
    const b: FixtureDefinition = [
      async ({ a: aValue }: any, use) => {
        void aValue;
        await use(2);
      },
      { scope: "process" },
    ];
    const graph = buildFixtureGraph(configWithFixtures({ a, b }));
    expect(findFixtureScopeViolations(graph)).toEqual([]);
  });

  it("does not flag a scenario-scope fixture depending on a scenario-scope builtin", () => {
    const tenant: FixtureDefinition = async ({ page }: any, use) => {
      void page;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    expect(findFixtureScopeViolations(graph)).toEqual([]);
  });
});

describe("findPageOverrideUnowned", () => {
  it("flags a page override that destructures neither page nor context", () => {
    const pageOverride: FixtureDefinition = async ({ request }: any, use) => {
      void request;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    const issues = findPageOverrideUnowned(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "page-override-unowned", fixture: "page" });
  });

  it("does not flag a page override that destructures page", () => {
    const pageOverride: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    expect(findPageOverrideUnowned(graph)).toEqual([]);
  });

  it("does not flag a page override that destructures context instead", () => {
    const pageOverride: FixtureDefinition = async ({ context }: any, use) => {
      const p = await context.newPage();
      await use(p);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    expect(findPageOverrideUnowned(graph)).toEqual([]);
  });

  it("returns [] when page is never overridden at all", () => {
    const graph = buildFixtureGraph(configWithFixtures({}));
    expect(findPageOverrideUnowned(graph)).toEqual([]);
  });
});

describe("fixtureReachesBrowser", () => {
  it("is true for page/context themselves", () => {
    const graph = buildFixtureGraph(configWithFixtures({}));
    expect(fixtureReachesBrowser("page", graph)).toBe(true);
    expect(fixtureReachesBrowser("context", graph)).toBe(true);
  });

  it("is false for another builtin", () => {
    const graph = buildFixtureGraph(configWithFixtures({}));
    expect(fixtureReachesBrowser("request", graph)).toBe(false);
  });

  it("is true for a user fixture that transitively reaches page", () => {
    const loggedIn: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const wrapper: FixtureDefinition = async ({ loggedIn: p }: any, use) => {
      void p;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ loggedIn, wrapper }));
    expect(fixtureReachesBrowser("wrapper", graph)).toBe(true);
  });

  it("is false for a user fixture that never reaches page/context", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    expect(fixtureReachesBrowser("tenant", graph)).toBe(false);
  });
});

describe("closeFixtureNames", () => {
  it("closes builtins directly, no user fixtures", () => {
    const graph = buildFixtureGraph(configWithFixtures({}));
    const closure = closeFixtureNames(["page", "request"], graph);
    expect([...closure.builtinNames].sort()).toEqual(["page", "request"]);
    expect(closure.userOrder).toEqual([]);
  });

  it("closes a user fixture's own builtin dependency too", () => {
    const tenant: FixtureDefinition = async ({ request }, use) => {
      void request;
      await use({});
    };
    const graph = buildFixtureGraph(configWithFixtures({ tenant }));
    const closure = closeFixtureNames(["tenant"], graph);
    expect(closure.builtinNames).toEqual(["request"]);
    expect(closure.userOrder).toEqual(["tenant"]);
  });

  it("orders dependencies before dependents", () => {
    const a: FixtureDefinition = async ({}, use) => {
      await use(1);
    };
    const b: FixtureDefinition = async ({ a: aValue }: any, use) => {
      void aValue;
      await use(2);
    };
    const graph = buildFixtureGraph(configWithFixtures({ a, b }));
    const closure = closeFixtureNames(["b"], graph);
    expect(closure.userOrder).toEqual(["a", "b"]);
  });

  it("a page override closure needs the raw builtin page plus the override itself, in order", () => {
    const pageOverride: FixtureDefinition = async ({ page }, use) => {
      await use(page);
    };
    const graph = buildFixtureGraph(configWithFixtures({ page: pageOverride }));
    const closure = closeFixtureNames(["page"], graph);
    expect(closure.builtinNames).toEqual(["page"]);
    expect(closure.userOrder).toEqual(["page"]);
  });

  it("does not include a fixture nobody asked for, even one another fixture depends on transitively, twice", () => {
    const a: FixtureDefinition = async ({}, use) => {
      await use(1);
    };
    const b: FixtureDefinition = async ({ a: aValue }: any, use) => {
      void aValue;
      await use(2);
    };
    const c: FixtureDefinition = async ({ a: aValue }: any, use) => {
      void aValue;
      await use(3);
    };
    const graph = buildFixtureGraph(configWithFixtures({ a, b, c }));
    const closure = closeFixtureNames(["b", "c"], graph);
    // `a` only appears once even though both b and c depend on it.
    expect(closure.userOrder.filter((name) => name === "a")).toHaveLength(1);
    expect(closure.userOrder.indexOf("a")).toBeLessThan(closure.userOrder.indexOf("b"));
    expect(closure.userOrder.indexOf("a")).toBeLessThan(closure.userOrder.indexOf("c"));
  });
});
