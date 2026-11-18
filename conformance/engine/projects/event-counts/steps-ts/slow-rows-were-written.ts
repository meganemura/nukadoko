import { defineStep, z } from "nukadoko";
import aSlowItemIsAdded from "./a-slow-item-is-added.ts";

export default defineStep({
  pattern: "{n:int} slow rows were written",
  description: "The slow item step wrote this many rows, as its execution events say, read before they all arrived",
  args: z.object({ n: z.number().int().describe("How many rows") }),
  timeout: 50,
  events: { writes: { of: aSlowItemIsAdded, count: { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } } },
  claims: [{ actual: "writes", compare: "equal", expected: "n" }],
});
