import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person signs in",
  pattern: "{person:word} signs in",
  args: z.object({ person: z.string().describe("Who signs in") }),
  gives: [["signed-in", "person"]],
  mutates: false,
  run() {},
});
