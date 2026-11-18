import { defineStep, z } from "nukadoko";
import anItemIsAdded from "./an-item-is-added.ts";

export default defineStep({
  pattern: "the add wrote {n:int} item",
  description: "The add wrote this many rows to the items table, as its execution events say",
  args: z.object({ n: z.number().int().describe("How many rows") }),
  events: { items: { of: anItemIsAdded, count: { kind: "db", table: "items", committed: true } } },
  claims: [{ actual: "items", compare: "equal", expected: "n" }],
});
