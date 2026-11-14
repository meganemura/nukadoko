import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the colour is shown",
  args: z.object({  }),
  observe() {
    return {};
  },
  claims: [{ actual: "colour", compare: "equal", expected: { literal: "red" } }],
});
