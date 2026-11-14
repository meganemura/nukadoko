import { defineStep, z } from "nukadoko";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { stepFile } from "./lib/engine.ts";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

export default defineStep({
  description: "Append one line to a file of the project, so the working tree differs from the one a run judged",
  pattern: "a line is added to {file:string}",
  args: z.object({
    file: z.string().describe("The file, relative to the project; features/steps/<name>.* is that step's file in this engine"),
    dir: theProjectInGit.returns.shape.dir,
  }),
  from: { dir: [[theProjectInGit, "dir"], [theProject, "dir"]] },
  // Writes only inside the scenario's scratch project.
  mutates: false,
  run({}, { file, dir }) {
    appendFileSync(path.join(dir, stepFile(file)), "# a comment added after the run\n");
    return {};
  },
});
