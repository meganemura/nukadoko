import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { intentTable, ownFieldsOf, parseIntent, sameValue, splitTerms, tableCells, termHolds, valueOf, valueText, type IntentRow } from "../src/run/intent.js";

// Responsibility: the intent file's format (src/run/intent.ts,
// docs/intent.md): a table read back as written, a value read back as
// written whatever it holds, a term that holds or not by its value, and
// the exact problem each unreadable row is named with.

const TEAM_INTENT = [
  "# Intent",
  "",
  "Team subscriptions with 10 or more seats get the audit log.",
  "",
  "| Target | Observation | Before | After |",
  "| --- | --- | --- | --- |",
  '| x_result.reason=plan:team x_result.seats>=10 | x_decision x_result.features | ["projects","sso"] | ["projects","sso","audit_log"] |',
  "",
].join("\n");

// A JSON value a cell may hold: text with spaces and pipes, numbers, and
// arrays of either.
const scalar = gs.oneOf<unknown>(
  gs.text({ maxSize: 8 }),
  gs.sampledFrom(["plan:team", "a b", "x|y", "", "10", "true", "null", '"q"']),
  gs.integers({ minValue: -5, maxValue: 50 }),
  gs.booleans(),
  gs.just(null),
);
const value = gs.oneOf<unknown>(scalar, gs.arrays(scalar, { maxSize: 3 }));
const field = gs.sampledFrom(["x_result.features", "x_result.seats", "x_subject.plan", "x_id"]);
const op = gs.sampledFrom(["=", "!=", "<", "<=", ">", ">="] as const);

// The cells of a row the format reads: tags and terms on a writer's own
// kind, and a value change, a count change, or none.
const rowCells = gs
  .tuples(
    gs.arrays(gs.sampledFrom(["@overage", "@team", "@a-b"]), { maxSize: 2 }),
    gs.arrays(gs.tuples(field, op, value), { maxSize: 2 }),
    gs.sampledFrom(["x_decision", "x_usage"]),
    gs.arrays(gs.tuples(field, op, value), { maxSize: 1 }),
    gs.oneOf<readonly [string | null, unknown, unknown]>(
      gs.just([null, undefined, undefined] as const),
      gs.tuples(gs.integers({ minValue: 0, maxValue: 3 }), gs.integers({ minValue: 0, maxValue: 3 })).filter(([a, b]) => a !== b).map(([a, b]) => [null, a, b] as const),
      gs.tuples(field, value, value).filter(([, a, b]) => !sameValue(a, b)).map(([name, a, b]) => [name, a, b] as const),
    ),
  )
  .map(([tags, conditions, kind, filters, [projection, before, after]]): IntentRow["cells"] => {
    const term = ([name, which, inner]: readonly [string, string, unknown]): string => `${name}${which}${valueText(inner)}`;
    return {
      target: [...tags, ...conditions.map(term)].join(" "),
      observation: [kind, ...filters.map(term), ...(projection === null ? [] : [projection])].join(" "),
      before: before === undefined ? "" : projection === null ? String(before) : valueText(before),
      after: after === undefined ? "" : projection === null ? String(after) : valueText(after),
    };
  });

describe("parseIntent", () => {
  it("reads back every row a table writes, cell by cell, with no problem", () =>
    hegel.test((tc) => {
      const rows = tc.draw(gs.arrays(rowCells, { maxSize: 4 }));
      const read = parseIntent(`Prose before.\n\n${intentTable(rows)}\n\nProse after.\n`);
      expect(read.problems).toEqual([]);
      expect(read.rows.map((row) => row.cells)).toEqual(rows);
      expect(read.rows.map((row) => row.row)).toEqual(rows.map((_, index) => index + 1));
    }));

  it("reads the team intent: tags none, two conditions, one observed field, a value change", () => {
    const { rows, problems } = parseIntent(TEAM_INTENT);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        row: 1,
        line: 7,
        cells: { target: "x_result.reason=plan:team x_result.seats>=10", observation: "x_decision x_result.features", before: '["projects","sso"]', after: '["projects","sso","audit_log"]' },
        tags: [],
        conditions: [
          { field: "x_result.reason", op: "=", value: "plan:team" },
          { field: "x_result.seats", op: ">=", value: 10 },
        ],
        kind: "x_decision",
        filters: [],
        projection: "x_result.features",
        change: { before: ["projects", "sso"], after: ["projects", "sso", "audit_log"] },
      },
    ]);
    expect(ownFieldsOf({ rows, problems })).toEqual(new Map([["x_decision", ["x_result.features", "x_result.reason", "x_result.seats"]]]));
  });

  it("names each row it cannot read by its line, and reads the rest", () => {
    const text = [
      "| Target | Observation | Before | After |",
      "| --- | --- | --- | --- |",
      "| @overage | http method=POST path=/usage_records | 0 | 1 |",
      "| | queue depth | 0 | 1 |",
      "| | db table=rooms op=read | 0 | 1 |",
      "| | db rows=2 | 0 | 1 |",
      "| | x_decision x_result.features | | 1 |",
      "| | x_decision actor=u1 | 0 | 1 |",
      "| | http method=POST | none | 1 call |",
      "| | x_decision x_a x_b | 0 | 1 |",
      "| plan | x_decision | 0 | 1 |",
      "| | request status | 200 | 200 |",
      "| a | b |",
    ].join("\n");
    const { rows, problems } = parseIntent(text);
    expect(rows.map((row) => row.row)).toEqual([1]);
    expect(problems).toEqual([
      { line: 4, message: "row 2: `queue` is not a kind a path keeps: one of `error`, `db`, `http`, `job`, `request`, `flag`, or a writer's own kind that starts with `x_`" },
      { line: 5, message: "row 3: a path keeps no database read, so `op=read` matches nothing" },
      { line: 6, message: "row 4: a path keeps a `db` line by `table`, `op`, not by `rows`" },
      { line: 7, message: "row 5: before and after are both empty, for no change, or both filled" },
      { line: 8, message: "row 6: a x_decision line is read only at a field of its own, which starts with `x_`, not at `actor`" },
      { line: 9, message: "row 7: an observation with no field to read counts lines, so before and after are whole numbers, not `none` and `1 call`" },
      { line: 10, message: "row 8: the observation names 2 fields with no value (`x_a`, `x_b`); it observes at most one" },
      { line: 11, message: "row 9: the target term `plan` names a field with no value; a target is tags and `field<op>value` terms" },
      { line: 12, message: "row 10: before and after are the same value; leave both empty for no change" },
      { line: 13, message: "row 11: has 2 cells, not 4" },
    ]);
  });

  it("says when no table has the header, and when the header has no delimiter row", () => {
    expect(parseIntent("No behavior changes.\n")).toEqual({ rows: [], problems: [{ line: null, message: "no table has the header `| Target | Observation | Before | After |`" }] });
    expect(parseIntent("| Target | Observation | Before | After |\n| x | y | 0 | 1 |\n").problems).toEqual([
      { line: 2, message: "the header is not followed by a delimiter row such as `| --- | --- | --- | --- |`" },
    ]);
  });

  it("reads a table with a header and no row as an intent that nothing changes", () => {
    expect(parseIntent("| Target | Observation | Before | After |\n| --- | --- | --- | --- |\n")).toEqual({ rows: [], problems: [] });
  });
});

describe("a cell", () => {
  const cellText = gs.text({ maxSize: 12 }).filter((text) => text === text.trim() && !/[\r\n\u2028\u2029]/.test(text));

  it("reads back from a table line whatever it holds, a pipe or a backslash included", () =>
    hegel.test((tc) => {
      const cells = tc.draw(gs.arrays(cellText, { minSize: 1, maxSize: 4 }));
      expect(tableCells(`| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`)).toEqual(cells);
    }));

  it("reads a value back as the same value, as one term", () =>
    hegel.test((tc) => {
      const written = tc.draw(value);
      const text = valueText(written);
      expect(sameValue(valueOf(text), written)).toBe(true);
      expect(splitTerms(`x_a=${text} x_b`)).toEqual([`x_a=${text}`, "x_b"]);
    }));
});

describe("termHolds", () => {
  it("holds for = exactly when it does not for !=, on a field the line has", () =>
    hegel.test((tc) => {
      const [held, named] = [tc.draw(value), tc.draw(value)];
      const line = { x_a: held };
      expect(termHolds({ field: "x_a", op: "=", value: named }, line)).toBe(!termHolds({ field: "x_a", op: "!=", value: named }, line));
      expect(termHolds({ field: "x_a", op: "=", value: held }, line)).toBe(true);
    }));

  it("orders two numbers as numbers, and meets no term on a field the line lacks", () =>
    hegel.test((tc) => {
      const [held, named] = [tc.draw(gs.integers({ minValue: -9, maxValue: 9 })), tc.draw(gs.integers({ minValue: -9, maxValue: 9 }))];
      const line = { x_result: { seats: held } };
      expect(termHolds({ field: "x_result.seats", op: ">=", value: named }, line)).toBe(held >= named);
      expect(termHolds({ field: "x_result.seats", op: "<", value: named }, line)).toBe(held < named);
      expect(termHolds({ field: "x_result.plan", op: "!=", value: named }, line)).toBe(false);
    }));

  it("reads a path's own key, whose dotted field is one name", () => {
    expect(termHolds({ field: "x_result.seats", op: ">=", value: 10 }, { kind: "x_decision", "x_result.seats": 12 })).toBe(true);
  });
});
