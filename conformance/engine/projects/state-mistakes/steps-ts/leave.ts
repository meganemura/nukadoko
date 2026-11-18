import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person leaves",
  pattern: "{person:word} leaves",
  args: z.object({ person: z.string().describe("Who leaves") }),
  gives: [["outside", "person"]],
  ends: [["outside", "person"]],
  mutates: false,
  run() {},
});
