import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

export default defineStep({
  pattern: "the project {name:string} can be looked up",
  description: "Check that the project the scenario created has the name the line states",
  args: z.object({
    name: z.string().describe("the project name"),
    created: z.string().describe("the name the earlier step created the project with"),
  }),
  from: { created: [createProject, "name"] },
  claims: [{ actual: "created", compare: "equal", expected: "name" }],
});
