import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { parseList, TABLE_HOLDS, type TableHolds } from "../src/execution-events/lists.js";

// Responsibility: the properties of reading a program's list
// (src/execution-events/lists.ts). A list printed as lines, with entries
// printed twice, blank lines, CR line ends, and keys of the program's own,
// reads back as each place once, with every handler or side any of its
// lines named, and each table with what it holds, `state` where no line
// says. One line that is not an entry of the kind, wherever it stands,
// makes the whole list unread, naming that line's number, and so does a
// table two lines say two different things of.

const METHODS = ["GET", "PUT", "PATCH", "DELETE", "POST"];
const ROUTES = ["/up", "/rooms/:id", "/rooms/:id/scores", "/orders/:id", "/*path"];
const HANDLERS = ["rooms#show", "rooms#update", "scores#create", "health#show"];

const routeLine = gs.composite((tc) => ({
  method: tc.draw(gs.sampledFrom(METHODS)),
  route: tc.draw(gs.sampledFrom(ROUTES)),
  ...(tc.draw(gs.booleans()) ? { handler: tc.draw(gs.sampledFrom(HANDLERS)) } : {}),
  ...(tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0 ? { x_name: "kept" } : {}),
}));

const flagLine = gs.composite((tc) => ({
  name: tc.draw(gs.sampledFrom(["quick_reorder", "slider_input", "dark_mode"])),
  sides: tc.draw(gs.arrays(gs.sampledFrom(["off", "on", "blue"]), { minSize: 1, maxSize: 3 })),
}));

const TABLES = ["rooms", "scores", "events", "schema_migrations", "solid_queue_jobs"];

/** What each table of TABLES holds in one program: a line names it, or
 * leaves it out when it is `state`. */
const tableHoldings = gs.arrays(gs.sampledFrom(TABLE_HOLDS), { minSize: TABLES.length, maxSize: TABLES.length });

/** The lines as a command prints them: blank lines between some, and CR
 * before some line feeds. */
function printed(tc: hegel.TestCase, lines: readonly string[]): string[] {
  return lines.flatMap((line) => [`${line}${tc.draw(gs.booleans()) ? "\r" : ""}`, ...(tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0 ? ["  "] : [])]);
}

const BAD_ROUTE_LINES = [
  "not json",
  "[1, 2]",
  JSON.stringify({ method: "GET" }),
  JSON.stringify({ method: "get", route: "/up" }),
  JSON.stringify({ method: "GET", route: "" }),
  JSON.stringify({ method: "GET", route: "/up", handler: 7 }),
  JSON.stringify({ method: "GET", route: "/up", path: "/up" }),
  '{"method":"GET","route":"/up","route":"/down"}',
];

describe("reading a program's list", () => {
  it("reads each route once, with every handler its lines named", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(routeLine, { maxSize: 12 }));
      const text = printed(
        tc,
        lines.map((line) => JSON.stringify(line)),
      ).join("\n");
      const read = parseList("routes", tc.draw(gs.booleans()) ? `${text}\n` : text);
      expect("entries" in read).toBe(true);
      if (!("entries" in read)) return;
      const expected = new Map<string, Set<string>>();
      for (const line of lines) {
        const key = JSON.stringify([line.method, line.route]);
        const handlers = expected.get(key) ?? new Set<string>();
        expected.set(key, handlers);
        if (line.handler !== undefined) handlers.add(line.handler);
      }
      expect(read.entries).toHaveLength(expected.size);
      for (const entry of read.entries) {
        expect(entry.handlers).toEqual([...(expected.get(JSON.stringify([entry.method, entry.route])) ?? [])].sort());
      }
    }));

  it("reads each flag once, with every side its lines declared", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(flagLine, { maxSize: 8 }));
      const read = parseList("flags", printed(tc, lines.map((line) => JSON.stringify(line))).join("\n"));
      expect("entries" in read).toBe(true);
      if (!("entries" in read)) return;
      expect(read.entries.map((entry) => entry.name).sort()).toEqual([...new Set(lines.map((line) => line.name))].sort());
      for (const entry of read.entries) {
        const sides = lines.filter((line) => line.name === entry.name).flatMap((line) => line.sides);
        expect(entry.sides).toEqual([...new Set(sides)]);
      }
    }));

  it("reads each table once, with what its lines say it holds, and state where none says", () =>
    hegel.test((tc) => {
      const holdings = tc.draw(tableHoldings);
      const named = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: TABLES.length - 1 }), { maxSize: 10 }));
      const lines = named.map((index) => {
        const holds = holdings[index]!;
        const quiet = holds === "state" && tc.draw(gs.booleans());
        return JSON.stringify({ table: TABLES[index], ...(quiet ? {} : { holds }), ...(tc.draw(gs.booleans()) ? { x_owner: "app" } : {}) });
      });
      const read = parseList("tables", printed(tc, lines).join("\n"));
      const expected = [...new Set(named)].map((index) => ({ table: TABLES[index]!, holds: holdings[index]! }));
      expect(read).toEqual({ entries: expected });
    }));

  it("reads no tables list that says two things of one table, naming both lines", () =>
    hegel.test((tc) => {
      const holds = tc.draw(gs.sampledFrom(TABLE_HOLDS));
      const other = tc.draw(gs.sampledFrom(TABLE_HOLDS.filter((value): value is TableHolds => value !== holds)));
      const between = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const said = (value: TableHolds): string => JSON.stringify(value === "state" && tc.draw(gs.booleans()) ? { table: "events" } : { table: "events", holds: value });
      const lines = [said(holds), ...Array.from({ length: between }, () => JSON.stringify({ table: "rooms" })), said(other)];
      expect(parseList("tables", lines.join("\n"))).toEqual({
        problem: `line ${between + 2} says table "events" holds ${other}, and line 1 says it holds ${holds}`,
      });
    }));

  it("reads no list that holds one line it cannot read, and names that line", () =>
    hegel.test((tc) => {
      const good = tc.draw(gs.arrays(routeLine, { maxSize: 6 })).map((line) => JSON.stringify(line));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: good.length }));
      const bad = tc.draw(gs.sampledFrom(BAD_ROUTE_LINES));
      const lines = [...good.slice(0, at), bad, ...good.slice(at)];
      const read = parseList("routes", lines.join("\n"));
      expect(read).toEqual({ problem: expect.stringMatching(new RegExp(`^line ${at + 1}[ ']`)) });
    }));

  it("says why a line is not one entry of its kind", () => {
    const problem = (kind: "routes" | "flags" | "tables", line: string) => {
      const read = parseList(kind, line);
      return "problem" in read ? read.problem : undefined;
    };
    expect(problem("routes", JSON.stringify({ method: "get", route: "/up" }))).toBe('line 1\'s method is "get", which is not uppercase, as a request line\'s method is');
    expect(problem("routes", JSON.stringify({ method: "GET", path: "/up" }))).toBe(
      'line 1 has the key "path", which a routes line does not have (method, route, handler, or an x_ key of the program\'s own)',
    );
    expect(problem("routes", '{"method":"GET","route":"/up","route":"/down"}')).toBe('line 1 holds the key "route" twice');
    expect(problem("flags", JSON.stringify({ name: "quick_reorder" }))).toBe("line 1 has no sides");
    expect(problem("flags", JSON.stringify({ name: "quick_reorder", sides: [] }))).toBe("line 1's sides is empty");
    expect(problem("tables", JSON.stringify({ table: "events", holds: "ledger" }))).toBe('line 1\'s holds is "ledger", which is not one of state, bookkeeping, infrastructure');
    expect(problem("tables", JSON.stringify({ name: "events" }))).toBe(
      'line 1 has the key "name", which a tables line does not have (table, holds, or an x_ key of the program\'s own)',
    );
    expect(parseList("routes", "")).toEqual({ entries: [] });
  });
});
