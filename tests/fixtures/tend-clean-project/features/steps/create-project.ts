import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  rationale: "Minimal identity step; no config surface needed for this fixture",
  args: z.object({ name: z.string().describe("the project's name") }),
  returns: z.object({
    id: z.string().describe("the created project's id"),
    name: z.string().describe("echoes the given name"),
  }),
  async run(_ctx, args) {
    return { id: "p_0001", name: args.name };
  },
});
