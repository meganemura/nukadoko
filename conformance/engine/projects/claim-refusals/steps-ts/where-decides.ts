import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "each done item is done",
  args: z.object({  }),
  observe() {
    return {};
  },
  claims: [{ actual: "items", each: { where: [{ actual: "done", compare: "equal", expected: { literal: "done" } }], claims: [{ actual: "done", compare: "equal", expected: { literal: "done" } }] } }],
});
