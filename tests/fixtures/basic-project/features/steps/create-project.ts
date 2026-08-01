import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import { formatId } from "./lib/format-id.js";

export default defineStep({
  pattern: "a project {string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run(_ctx, args) {
    return { id: formatId("p", 1), name: args.name };
  },
});
