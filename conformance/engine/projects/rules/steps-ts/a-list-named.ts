import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Start a list by its name",
  pattern: "a list named {name:string}",
  args: z.object({ name: z.string().describe("The list's name") }),
  returns: z.object({ name: z.string().describe("The list's name") }),
  // Keeps nothing.
  mutates: false,
  run({}, { name }) {
    return { name };
  },
});
