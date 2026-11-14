import { defineStep, z } from "nukadoko";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

export default defineStep({
  description: "Read the summary.md of the project's one run, for a later step to compare with",
  pattern: "the run's summary is read",
  args: z.object({ dir: theProject.returns.shape.dir }),
  from: { dir: [[theProject, "dir"], [theProjectInGit, "dir"]] },
  returns: z.object({ summary: z.string().describe("The whole summary.md the run wrote") }),
  mutates: false,
  async run({}, { dir }) {
    const runs = path.join(dir, ".nukadoko", "runs");
    const [only] = readdirSync(runs);
    return { summary: readFileSync(path.join(runs, only ?? "", "summary.md"), "utf8") };
  },
});
