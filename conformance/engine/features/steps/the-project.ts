import { defineStep, z } from "nukadoko";
import { buildProject } from "./lib/engine.ts";

export default defineStep({
  description: "Copy a project from conformance/engine/projects into a fresh scratch directory, with the steps written for this world's engine",
  pattern: "the project {name:string}",
  args: z.object({
    name: z.string().describe("The project's directory name under conformance/engine/projects"),
  }),
  returns: z.object({
    dir: z.string().describe("The scratch directory that holds the project"),
  }),
  // Writes only inside the scenario's own scratch directory, which is removed after it.
  mutates: false,
  run({ scratch }, { name }) {
    const dir = scratch.dir();
    buildProject(name, dir);
    return { dir };
  },
});
