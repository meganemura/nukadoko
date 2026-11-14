import { defineStep, z } from "nukadoko";
import makeList from "./make-list.ts";

export default defineStep({
  description: "The list against a total observe reads",
  pattern: "the list is as long as the shown total",
  args: z.object({ made: z.array(z.string()).describe("The items") }),
  from: { made: [makeList, "items"] },
  observe() {
    return { shown: 3 };
  },
  claims: [{ actual: "made", count: true, compare: "equal", expected: { observe: "shown" } }],
});
