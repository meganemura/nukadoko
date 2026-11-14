import { defineStep, z } from "nukadoko";
import makeItem from "./make-item.ts";

export default defineStep({
  description: "A claim on the item",
  pattern: "the item is itself",
  args: z.object({ made: z.unknown().describe("The item") }),
  from: { made: [makeItem, "item"] },
  claims: [{ actual: "made", compare: "equal", expected: { from: "made" } }],
});
