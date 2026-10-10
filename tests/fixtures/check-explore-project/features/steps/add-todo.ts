import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Create a todo through the request fixture",
  args: z.object({ title: z.string() }),
  returns: z.object({ title: z.string() }),
  async run({ request }, args) {
    await request.get("/todos");
    return { title: args.title };
  },
});
