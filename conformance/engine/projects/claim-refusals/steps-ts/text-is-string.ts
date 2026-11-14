import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the note as text is a string",
  args: z.object({  }),
  observe() {
    return {};
  },
  claims: [{ actual: "note", view: "text", compare: "is-a", expected: { literal: "string" } }],
});
