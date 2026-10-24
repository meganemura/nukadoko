import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string().describe("the project name") }),
  returns: z.object({ id: z.string().describe("the new project id"), name: z.string().describe("the project name") }),
  mutates: true,
  async run({}, args) {
    return { id: "p_0001", name: args.name };
  },
});
