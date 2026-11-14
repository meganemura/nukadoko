import { defineStep, z } from "nukadoko";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

export default defineStep({
  description: "Write a file of the project's working tree after its commit, so the working tree holds a change against that commit",
  pattern: "the file {file:string} reads",
  args: z.object({
    file: z.string().describe("The file, relative to the project"),
    text: z.string().describe("The file's whole text, without its last newline"),
    dir: theProjectInGit.returns.shape.dir,
  }),
  from: { dir: [theProjectInGit, "dir"] },
  // Writes only inside the scenario's scratch project.
  mutates: false,
  run({}, { file, text, dir }) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), `${text}\n`);
    return {};
  },
});
