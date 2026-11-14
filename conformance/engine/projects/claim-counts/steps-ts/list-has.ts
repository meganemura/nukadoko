import { defineStep, z } from "nukadoko";
import makeList from "./make-list.ts";

export default defineStep({
  description: "How many items the list has",
  pattern: "the list has {n:int} items",
  args: z.object({ n: z.number().describe("How many"), made: z.array(z.string()).describe("The items") }),
  from: { made: [makeList, "items"] },
  claims: [{ actual: "made", count: true, compare: "equal", expected: "n" }],
});
