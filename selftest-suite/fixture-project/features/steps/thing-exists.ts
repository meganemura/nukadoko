import { z } from "zod";
import { defineStep } from "nukadoko";

export default defineStep({
  pattern: "a thing {name:string} exists",
  description: "Create a thing and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({}, args) {
    return { id: "t_0001", name: args.name };
  },
});
