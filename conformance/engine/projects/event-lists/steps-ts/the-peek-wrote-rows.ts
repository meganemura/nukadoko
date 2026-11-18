import { defineStep, z } from "nukadoko";
import theItemsArePeeked from "./the-items-are-peeked.ts";

export default defineStep({
  pattern: "the peek wrote {n:int} rows",
  description: "The peek wrote this many rows to tables that hold state, as its execution events say",
  args: z.object({ n: z.number().int().describe("How many rows") }),
  events: { writes: { of: theItemsArePeeked, count: { kind: "db", committed: true } } },
  claims: [{ actual: "writes", compare: "equal", expected: "n" }],
});
