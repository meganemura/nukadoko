import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Makes an item",
  pattern: "an item is made",
  args: z.object({}),
  returns: z.object({ item: z.object({ id: z.number().describe("Its id"), name: z.string().describe("Its name") }).describe("The item"), tags: z.string().describe("Its tags") }),
  mutates: false,
  run() {
    return { item: { id: 1, name: "a" }, tags: "x,y" };
  },
});
