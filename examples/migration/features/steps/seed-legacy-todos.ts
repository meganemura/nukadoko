import { DataTable, Given } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

// Still cucumber-js-shaped glue (README.md's Stage 1: "the import is the
// only line that moved"): a string pattern with no named capture, a
// trailing Gherkin table read with `.hashes()` -- a header row plus data
// rows, the shape most real legacy tables actually take -- and a plain POST
// per row through `this.request` (opened once, by ../steps/hooks.ts's
// Before hook). The row count it stashes onto `this.seededCount` is this
// suite's one declared World key (see ../support/world.ts) -- a legacy-
// looking write, but a validated one now.
Given("the following legacy todos are seeded:", async function (this: MigrationWorld, table: DataTable) {
  const rows = table.hashes();
  for (const row of rows) {
    await this.request.post("/todos", { data: { title: row.title } });
  }
  this.seededCount = rows.length;
});
