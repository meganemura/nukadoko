import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Name the list's owner",
  pattern: "an owner {name:string}",
  args: z.object({ name: z.string().min(1).describe("The owner's name") }),
  returns: z.object({ name: z.string().describe("The owner's name") }),
  // Keeps nothing.
  mutates: false,
  run({}, { name }) {
    return { name };
  },
});
