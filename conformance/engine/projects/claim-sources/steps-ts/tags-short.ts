import { defineStep, z } from "nukadoko";
import makeItem from "./make-item.ts";

export default defineStep({
  description: "A claim on the item",
  pattern: "each tag of the item is a string",
  args: z.object({ made: z.unknown().describe("The item") }),
  from: { made: [makeItem, "tags"] },
  claims: [{ actual: "made", each: { claims: [{ compare: "is-a", expected: { literal: "string" } }] } }],
});
