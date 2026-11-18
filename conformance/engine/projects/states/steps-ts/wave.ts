import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person waves",
  pattern: "{person:word} waves",
  args: z.object({ person: z.string().describe("Who waves") }),
  mutates: false,
  run() {},
});
