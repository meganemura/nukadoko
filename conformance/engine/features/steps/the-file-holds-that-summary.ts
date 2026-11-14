import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";
import theRunsSummaryIsRead from "./the-runs-summary-is-read.ts";

export default defineStep({
  description: "A file in the project holds exactly the summary an earlier step read",
  pattern: "the file {file:string} holds that summary",
  args: z.object({
    file: z.string().describe("A path relative to the project"),
    dir: theProject.returns.shape.dir,
    summary: theRunsSummaryIsRead.returns.shape.summary,
  }),
  from: { dir: [[theProject, "dir"], [theProjectInGit, "dir"]], summary: [theRunsSummaryIsRead, "summary"] },
  observe({}, { file, dir }) {
    return { report: readFileSync(path.join(dir, file), "utf8") };
  },
  claims: [{ actual: "report", compare: "equal", expected: { from: "summary" } }],
});
