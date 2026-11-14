import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Makes a list",
  pattern: "a list is made",
  args: z.object({}),
  returns: z.object({ items: z.array(z.string()).describe("The items"), name: z.string().describe("Its name") }),
  mutates: false,
  run() {
    return { items: ["a", "b", "c"], name: "abc" };
  },
});
