import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person enters the hall",
  pattern: "{person:word} enters",
  args: z.object({ person: z.string().describe("Who enters") }),
  gives: [["inside", "person"]],
  mutates: false,
  run() {},
});
