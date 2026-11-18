import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person signs out",
  pattern: "{person:word} signs out",
  args: z.object({ person: z.string().describe("Who signs out") }),
  ends: [["signed-in", "person"]],
  mutates: false,
  run() {},
});
