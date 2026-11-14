import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { ServedRequest } from "../src/execution-events/format.js";
import type { ListedRoute } from "../src/execution-events/lists.js";
import type { RunScenario } from "../src/record/run-result.js";
import { routeRows } from "../src/run/route-rows.js";
import { buildTable, type ExecutionOutcome } from "../src/run/verdict-table.js";

// Responsibility: the properties of run.json's `routes` over runs the
// verdict table judges as `nuka run` does: two environments, each of
// which read a routes list or did not, executions with their own
// outcomes and request lines, and executions of the base world mixed in.
// Every request line of a head execution lands in exactly one entry,
// the one with its method and route, whether a list names it, no list
// does, or the program matched no route, and in one cell of that entry's
// criterion; a line of the base world lands in none. Every route a read
// list names has an entry that names each environment whose list holds
// it, and no entry stands without a list or a request to put it there.
// The exact entries of a real run are tests/program-routes.test.ts's.

const ENVIRONMENTS = [
  { name: "x-off", conditions: { x: false } },
  { name: "x-on", conditions: { x: true } },
] as const;

const METHODS = ["GET", "PUT", "PATCH"];
const ROUTES = ["/rooms/:id", "/scores", "/up", null];

interface Execution {
  readonly id: string;
  readonly criterion: number;
  readonly environment: string;
  readonly world?: "base";
  readonly outcome: ExecutionOutcome;
  readonly requests: readonly ServedRequest[];
}

const request = gs.composite((tc) => ({
  method: tc.draw(gs.sampledFrom(METHODS)),
  route: tc.draw(gs.sampledFrom(ROUTES)),
  status: tc.draw(gs.sampledFrom([200, 303, 404, 422])),
}));

const listedRoute = gs.composite(
  (tc): ListedRoute => ({
    method: tc.draw(gs.sampledFrom(METHODS)),
    route: tc.draw(gs.sampledFrom(["/rooms/:id", "/scores", "/up", "/orders/:id"])),
    handlers: tc.draw(gs.booleans()) ? [tc.draw(gs.sampledFrom(["rooms#show", "rooms#update"]))] : [],
  }),
);

const outcome = gs.sampledFrom<ExecutionOutcome>([
  { kind: "pass" },
  { kind: "fail", line: 3, claim: 0, actual: { value: 1 } },
  { kind: "broke", line: 2 },
]);

const runGen = gs.composite((tc) => {
  const tagged = tc.draw(gs.arrays(gs.booleans(), { minSize: 1, maxSize: 3 }));
  const executions: Execution[] = [];
  for (const [criterion] of tagged.entries()) {
    for (const environment of ENVIRONMENTS) {
      const runs = tc.draw(gs.integers({ minValue: 1, maxValue: 2 }));
      for (let run = 0; run < runs; run += 1) {
        executions.push({
          id: `scn-${executions.length}`,
          criterion,
          environment: environment.name,
          ...(tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0 ? { world: "base" as const } : {}),
          outcome: tc.draw(outcome),
          requests: tc.draw(gs.arrays(request, { maxSize: 4 })),
        });
      }
    }
  }
  // An environment whose list was not read has none; one that was read
  // may hold no route, or one route twice, as a list read whole may not.
  const listed = ENVIRONMENTS.flatMap((environment) => {
    if (!tc.draw(gs.booleans())) return [];
    const routes = tc.draw(gs.arrays(listedRoute, { maxSize: 5 }));
    const unique = [...new Map(routes.map((route) => [JSON.stringify([route.method, route.route]), route])).values()];
    return [{ environment: environment.name, routes: unique }];
  });
  return { tagged, executions, listed };
});

function build(tagged: readonly boolean[], executions: readonly Execution[], listed: Parameters<typeof routeRows>[0]["listed"]) {
  const table = buildTable({
    criteria: tagged.map((withX, index) => ({ feature: "features/f.feature", line: index + 1, name: `c${index}`, tags: withX ? ["@with:x"] : [] })),
    environments: ENVIRONMENTS,
    outcomes: (_feature, line, environment, world = "head") =>
      executions
        .filter((entry) => entry.criterion === line - 1 && entry.environment === environment && (entry.world ?? "head") === world)
        .map((entry) => entry.outcome),
    notRunReason: () => undefined,
    proofRuns: 2,
    leftOut: 0,
  });
  const scenarios: Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[] = executions.map((entry) => ({
    scenario_record_id: entry.id,
    feature: "features/f.feature",
    line: entry.criterion + 1,
    environment: entry.environment,
    ...(entry.world === undefined ? {} : { world: entry.world }),
  }));
  const served = new Map(executions.map((entry) => [entry.id, entry.requests]));
  return { table, routes: routeRows({ scenarios, table, served: (id) => served.get(id) ?? [], listed }) };
}

const keyOf = (place: { readonly method: string; readonly route: string | null }): string => JSON.stringify([place.method, place.route]);

describe("run.json's routes", () => {
  it("puts every request line of a head execution in exactly one entry, and in one cell of it", () =>
    hegel.test((tc) => {
      const { tagged, executions, listed } = tc.draw(runGen);
      const { routes } = build(tagged, executions, listed);
      const head = executions.filter((entry) => entry.world === undefined);
      expect(routes.reduce((total, route) => total + route.requests, 0)).toBe(head.reduce((total, entry) => total + entry.requests.length, 0));
      for (const route of routes) {
        const lines = head.flatMap((entry) => entry.requests.filter((line) => keyOf(line) === keyOf(route)));
        expect(route.requests).toBe(lines.length);
        expect(route.statuses).toEqual([...new Set(lines.map((line) => line.status))].sort((a, b) => a - b));
        // Each line of a head execution is in its criterion's cell for
        // that environment, so the cells hold every request and no more.
        const inCells = route.criteria.flatMap((criterion) => criterion.cells).reduce((total, cell) => total + cell.requests, 0);
        expect(inCells).toBe(route.requests);
        for (const criterion of route.criteria) {
          for (const cell of criterion.cells) {
            const sent = head.filter((entry) => entry.criterion === criterion.line - 1 && entry.environment === cell.environment).flatMap((entry) => entry.requests.filter((line) => keyOf(line) === keyOf(route)));
            expect(cell.requests).toBe(sent.length);
          }
        }
      }
      expect(new Set(routes.map(keyOf)).size).toBe(routes.length);
    }));

  it("names each environment whose list holds a route, and holds no entry that no list or request put there", () =>
    hegel.test((tc) => {
      const { tagged, executions, listed } = tc.draw(runGen);
      const { routes } = build(tagged, executions, listed);
      for (const { environment, routes: list } of listed) {
        for (const entry of list) {
          const route = routes.find((candidate) => keyOf(candidate) === keyOf(entry));
          expect(route?.listed_in).toContain(environment);
          for (const handler of entry.handlers) expect(route?.handlers).toContain(handler);
        }
      }
      for (const route of routes) {
        const listedIn = listed.filter(({ routes: list }) => list.some((entry) => keyOf(entry) === keyOf(route))).map(({ environment }) => environment);
        expect(route.listed_in).toEqual(listedIn);
        expect(listedIn.length > 0 || route.requests > 0).toBe(true);
        if (route.route === null) expect(route.listed_in).toEqual([]);
        const { held, proven, failed, unproven, moved, controls } = route.counts;
        expect(held + proven + failed + unproven + moved + controls).toBe(route.criteria.length);
      }
    }));

  it("lists the entries by route, the requests no route matched last, then by method", () =>
    hegel.test((tc) => {
      const { tagged, executions, listed } = tc.draw(runGen);
      const { routes } = build(tagged, executions, listed);
      const order = routes.map((route) => [route.route ?? "￿", route.method].join("\u0000"));
      expect(order).toEqual([...order].sort());
    }));
});
