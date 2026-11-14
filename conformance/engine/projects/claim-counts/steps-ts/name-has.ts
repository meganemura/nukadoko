import { defineStep, z } from "nukadoko";
import makeList from "./make-list.ts";

export default defineStep({
  description: "How many items the name has",
  pattern: "the name has {n:int} items",
  args: z.object({ n: z.number().describe("How many"), made: z.string().describe("The name") }),
  from: { made: [makeList, "name"] },
  claims: [{ actual: "made", count: true, compare: "equal", expected: "n" }],
});
