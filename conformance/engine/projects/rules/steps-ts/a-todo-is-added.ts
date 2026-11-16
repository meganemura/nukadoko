import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Add an open todo",
  pattern: "a todo {title:string} is added",
  args: z.object({ title: z.string().describe("The todo's title") }),
  returns: z.object({ state: z.string().describe("The todo's state") }),
  // Keeps nothing.
  mutates: false,
  run({}, {}) {
    return { state: "open" };
  },
});
