import type { ServedRequest } from "../execution-events/format.js";
import type { ListedRoute } from "../execution-events/lists.js";
import type { RunRoute, RunScenario, RunTable } from "../record/run-result.js";
import { countsOf, criteriaByPlace } from "./place-criteria.js";

// Responsibility: run.json's `routes` (docs/spec.md "Lists"): every
// route the program's lists name, and every method and route its
// `request` lines name, each with the requests head steps sent it, the
// statuses they got, and the criteria that sent them, so a route no step
// requested stands in the same list as the ones that were. Pure.
// Boundary: what each world's list holds is read when the world starts
// (src/program/world.ts), the requests each step sent when it stops
// (src/context/events-file.ts), and how a criterion stands at a route is
// src/run/place-criteria.ts's; this module adds no verdict.
//
// A request line names the route the program matched, not what a step
// claimed on the answer, so a Given's request counts as a Then's does,
// and an entry says requested, never checked.
//
// Lists are read per world, and an entry's `listed_in` names each
// environment whose list holds it, so a route one environment's program
// lacks is told from one its steps never requested. Every request line of
// a head step lands in exactly one entry: the one with its method and
// route, which is a route no list names when none does, and one whose
// route is `null` when the program matched none.

export interface RouteRowsInput {
  /** Every execution of the run. */
  readonly scenarios: readonly Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[];
  readonly table: Pick<RunTable, "rows">;
  /** The requests an execution's steps sent that a `request` line
   * reports, one per line, by its scenario record id. */
  readonly served: (scenarioRecordId: string) => readonly ServedRequest[];
  /** Each environment whose routes list was read, with the list, in the
   * run's order. */
  readonly listed: readonly { readonly environment: string; readonly routes: readonly ListedRoute[] }[];
}

interface Entry {
  readonly method: string;
  readonly route: string | null;
  readonly handlers: Set<string>;
  readonly listedIn: string[];
  requests: number;
  readonly statuses: Set<number>;
}

const keyOf = (place: { readonly method: string; readonly route: string | null }): string => JSON.stringify([place.method, place.route]);

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// By route, a route no line matched last, then by method.
function byRoute(a: RunRoute, b: RunRoute): number {
  if (a.route !== b.route) return a.route === null ? 1 : b.route === null ? -1 : byText(a.route, b.route);
  return byText(a.method, b.method);
}

const ascending = (statuses: Iterable<number>): number[] => [...new Set(statuses)].sort((a, b) => a - b);

/** One entry per method and route a head world's list or a head step's
 * request line names. Pure. */
export function routeRows(input: RouteRowsInput): RunRoute[] {
  const entries = new Map<string, Entry>();
  const entryOf = (method: string, route: string | null): Entry => {
    const key = keyOf({ method, route });
    const entry = entries.get(key) ?? { method, route, handlers: new Set(), listedIn: [], requests: 0, statuses: new Set() };
    entries.set(key, entry);
    return entry;
  };
  for (const { environment, routes } of input.listed) {
    for (const listed of routes) {
      const entry = entryOf(listed.method, listed.route);
      if (!entry.listedIn.includes(environment)) entry.listedIn.push(environment);
      for (const handler of listed.handlers) entry.handlers.add(handler);
    }
  }
  for (const scenario of input.scenarios) {
    if (scenario.world !== undefined) continue;
    for (const request of input.served(scenario.scenario_record_id)) {
      const entry = entryOf(request.method, request.route);
      entry.requests += 1;
      entry.statuses.add(request.status);
    }
  }
  const reached = criteriaByPlace({
    scenarios: input.scenarios,
    table: input.table,
    visits: (id) => input.served(id).map(({ method, route, status }) => ({ place: { method, route }, detail: status })),
    keyOf,
    cellOf: (statuses) => ({ requests: statuses.length, statuses: ascending(statuses) }),
  });
  return [...entries]
    .map(([key, entry]): RunRoute => {
      const criteria = reached.get(key)?.criteria ?? [];
      return {
        method: entry.method,
        route: entry.route,
        handlers: [...entry.handlers].sort(byText),
        listed_in: entry.listedIn,
        requests: entry.requests,
        statuses: ascending(entry.statuses),
        criteria,
        counts: countsOf(criteria),
      };
    })
    .sort(byRoute);
}
