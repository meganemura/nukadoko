import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "List two things",
  pattern: "I list these",
  args: z.object({ a: z.string().describe("The first"), b: z.string().describe("The second") }),
  mutates: false,
  run({ store }) {
    return { size: store.size };
  },
});
