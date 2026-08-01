import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the project {string} can be looked up by id",
  description: "Look up a project by id and return its name",
  args: z.object({ id: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: false,
  async run(ctx, args) {
    const res = await (await ctx.request()).get(`/projects/${args.id}`);
    return res.json();
  },
});
