import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

export default defineStep({
  pattern: "the project is named {name:string}",
  description: "Check the name the project was created with",
  args: z.object({
    name: z.string().describe("the name the line states"),
    created: z.string().describe("the name the project was created with, filled by from"),
  }),
  from: { created: [createProject, "name"] },
  claims: [{ actual: "created", compare: "equal", expected: "name" }],
});
