import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the item is red",
  args: z.object({  }),
  observe() {
    return {};
  },
  claims: [{ actual: "item", compare: "has-fields", expected: { literal: "red" } }],
});
