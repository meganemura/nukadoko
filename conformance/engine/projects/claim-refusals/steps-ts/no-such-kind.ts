import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the id is a thing",
  args: z.object({  }),
  observe() {
    return {};
  },
  claims: [{ actual: "id", compare: "is-a", expected: { literal: "thing" } }],
});
