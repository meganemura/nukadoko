import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Place one book; a part with no pattern of its own",
  args: z.object({ title: z.string().describe("The title of the book") }),
  mutates: true,
  run() {
    return {};
  },
});
