import { describe, expect, it } from "vitest";
import { DataTable } from "../src/compat/data-table.js";

// Responsibility: unit coverage for src/compat/data-table.ts:
// raw()/rows()/hashes()/rowsHash()/transpose() against plain `string[][]`
// input, independent of any pickle/CLI plumbing. tests/compat-run.test.ts
// covers the one required e2e (a compat step calling `table.hashes()`
// through `nuka run`).

describe("DataTable", () => {
  const rows = [
    ["name", "age"],
    ["alice", "30"],
    ["bob", "25"],
  ];

  it("raw() returns every row, header included, as a fresh array", () => {
    const table = new DataTable(rows);
    const raw = table.raw();
    expect(raw).toEqual(rows);
    // Fresh copy: mutating the returned array must not affect the table.
    raw[0]![0] = "mutated";
    expect(table.raw()[0]![0]).toBe("name");
  });

  it("rows() returns every row except the header", () => {
    const table = new DataTable(rows);
    expect(table.rows()).toEqual([
      ["alice", "30"],
      ["bob", "25"],
    ]);
  });

  it("hashes() uses the first row as keys for every remaining row", () => {
    const table = new DataTable(rows);
    expect(table.hashes()).toEqual([
      { name: "alice", age: "30" },
      { name: "bob", age: "25" },
    ]);
  });

  it("hashes() on a header-only table returns an empty array", () => {
    const table = new DataTable([["name", "age"]]);
    expect(table.hashes()).toEqual([]);
  });

  it("rowsHash() folds every row (no header) into one object", () => {
    const table = new DataTable([
      ["name", "alice"],
      ["age", "30"],
    ]);
    expect(table.rowsHash()).toEqual({ name: "alice", age: "30" });
  });

  it("rowsHash() throws a clear message when a row isn't exactly 2 cells", () => {
    const table = new DataTable([
      ["name", "alice"],
      ["age", "30", "extra"],
    ]);
    expect(() => table.rowsHash()).toThrow(/exactly 2 cells/);
  });

  it("transpose() swaps rows and columns", () => {
    const table = new DataTable(rows);
    expect(table.transpose().raw()).toEqual([
      ["name", "alice", "bob"],
      ["age", "30", "25"],
    ]);
  });

  it("transpose() twice returns the original shape", () => {
    const table = new DataTable(rows);
    expect(table.transpose().transpose().raw()).toEqual(rows);
  });
});
