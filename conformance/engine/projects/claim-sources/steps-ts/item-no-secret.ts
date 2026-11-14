import { defineStep, z } from "nukadoko";
import makeItem from "./make-item.ts";

export default defineStep({
  description: "A claim on the item",
  pattern: "the item has no secret",
  args: z.object({ made: z.unknown().describe("The item") }),
  from: { made: [makeItem, "item"] },
  claims: [{ actual: "made", compare: "lacks-field", expected: { literal: "secret" } }],
});
