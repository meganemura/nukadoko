// Responsibility: a thin, dependency-free stand-in for cucumber-js's own
// DataTable class: the migration-door rule is binary, not friction-scaled —
// legacy glue calling `table.hashes()` would throw against a raw
// `string[][]`, which is a working asset breaking on an import switch, and
// the door forbids that. A compat step whose pickle step carries a Gherkin
// table receives an instance of this class as its trailing argument; a
// typed step is untouched by this file entirely — it keeps receiving the
// raw `string[][]` it always has, checked by zod (docs/spec.md "Typed
// steps": tables get types there, deliberately not here). Covers only the
// commonly used reader methods cucumber-js's own DataTable has
// (`raw`/`rows`/`hashes`/`rowsHash`/`transpose`); more (e.g. `diff`) is
// added only when a real migration needs it — the same "commonly used
// subset, grown on demand" rule as every other compat surface.

export class DataTable {
  private readonly source: readonly (readonly string[])[];

  constructor(source: readonly (readonly string[])[]) {
    this.source = source;
  }

  /** Every row, header included, exactly as the pickle table carried it. */
  raw(): string[][] {
    return this.source.map((row) => [...row]);
  }

  /** Every row *except* the first (the header row). */
  rows(): string[][] {
    return this.source.slice(1).map((row) => [...row]);
  }

  /** The first row as keys, one object per remaining row — cucumber-js's own
   * `hashes()`: a table's most common shape, a header row plus data rows. */
  hashes(): Record<string, string>[] {
    const [header, ...rest] = this.source;
    if (header === undefined) {
      return [];
    }
    return rest.map((row) => {
      const record: Record<string, string> = {};
      header.forEach((key, index) => {
        record[key] = row[index] ?? "";
      });
      return record;
    });
  }

  /** A two-column table (key, value per row) folded into one object —
   * cucumber-js's own `rowsHash()`. Unlike `hashes()`, every row (there is
   * no header row of its own) becomes one entry.
   * @throws if any row doesn't have exactly 2 cells, matching cucumber-js's
   *   own behavior for a table that isn't actually two columns wide. */
  rowsHash(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const row of this.source) {
      if (row.length !== 2) {
        throw new Error(
          `DataTable.rowsHash() requires every row to have exactly 2 cells; found a row with ${row.length} cell${row.length === 1 ? "" : "s"}`,
        );
      }
      record[row[0]!] = row[1]!;
    }
    return record;
  }

  /** Rows and columns swapped, as a new DataTable — cucumber-js's own
   * `transpose()`. */
  transpose(): DataTable {
    const columnCount = this.source[0]?.length ?? 0;
    const transposed: string[][] = [];
    for (let column = 0; column < columnCount; column++) {
      transposed.push(this.source.map((row) => row[column] ?? ""));
    }
    return new DataTable(transposed);
  }
}
