import { defineStep, z } from "nukadoko";
import { appendFileSync } from "node:fs";
import path from "node:path";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

export default defineStep({
  description: "Append one line to a file of the project, so the working tree differs from the one a run judged",
  pattern: "a line is added to {file:string}",
  args: z.object({
    file: z.string().describe("The file, relative to the project"),
    dir: theProjectInGit.returns.shape.dir,
  }),
  from: { dir: [theProjectInGit, "dir"] },
  // Writes only inside the scenario's scratch project.
  mutates: false,
  run({}, { file, dir }) {
    appendFileSync(path.join(dir, file), "# a comment added after the run\n");
    return {};
  },
});
