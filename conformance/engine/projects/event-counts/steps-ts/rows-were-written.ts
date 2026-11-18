import { defineStep, z } from "nukadoko";
import anItemIsAdded from "./an-item-is-added.ts";

export default defineStep({
  pattern: "{n:int} rows were written to {table:string}",
  description: "The item step wrote this many rows to the table, as its execution events say",
  args: z.object({ n: z.number().int().describe("How many rows"), table: z.string().describe("The table the rows went to") }),
  events: {
    writes: { of: anItemIsAdded, count: { kind: "db", table: { sentence: "table" }, op: ["insert", "update", "delete", "other"], committed: true } },
  },
  claims: [{ actual: "writes", compare: "equal", expected: "n" }],
});
