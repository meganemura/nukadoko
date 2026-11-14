import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A pattern that names a type no one registered",
  pattern: "I paint it {c:color}",
  args: z.object({ c: z.string().describe("A color") }),
  run() {
    return {};
  },
});
