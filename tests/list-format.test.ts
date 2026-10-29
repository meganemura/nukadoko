import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { parseList } from "../src/execution-events/lists.js";

// Responsibility: the properties of reading a program's list
// (src/execution-events/lists.ts). A list printed as lines, with entries
// printed twice, blank lines, CR line ends, and keys of the program's own,
// reads back as each place once, with every handler or side any of its
// lines named. One line that is not an entry of the kind, wherever it
// stands, makes the whole list unread, naming that line's number.

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
    const problem = (kind: "routes" | "flags", line: string) => {
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
    expect(parseList("routes", "")).toEqual({ entries: [] });
  });
});
