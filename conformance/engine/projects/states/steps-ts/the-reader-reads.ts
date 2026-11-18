import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Whoever is signed in reads",
  pattern: "the reader reads",
  args: z.object({ person: z.string().describe("Who reads").optional() }),
  requires: [["signed-in", "person"]],
  mutates: false,
  run() {},
});
