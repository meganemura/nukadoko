import { defineStep, z } from "nukadoko";
import countItems from "./count-items.ts";

// Other scenarios share the server, so the count holds their items too; the
// claim is that the item this scenario created is counted.
export default defineStep({
  description: "The item count the API answered is at least 1",
  pattern: "the response body has a count of at least 1",
  args: z.object({ body: z.unknown().describe("The body the count request got") }),
  from: { body: [countItems, "body"] },
  claims: [{ actual: "body", at: "count", compare: "at-least", expected: { literal: 1 } }],
});
