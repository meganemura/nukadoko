import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Makes a thing",
  pattern: "a thing is made",
  args: z.object({}),
  returns: z.object({ thing: z.string().describe("The thing") }),
  mutates: false,
  run() {
    return { thing: "a" };
  },
});
