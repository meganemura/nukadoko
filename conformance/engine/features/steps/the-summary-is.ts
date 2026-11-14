import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

// What differs between two runs of the same project: ids, times, how long
// the run took, and the version that wrote it.
function steady(text: string): string {
  return text
    .replace(/\b(run|step)-\d{8}-\d{6}-[a-z0-9]{4}\b/g, "$1-<id>")
    .replace(/- started \S+, finished \S+ \([^)]*\)/g, "- started <time>, finished <time> (<duration>)")
    .replace(/^- nukadoko: .*$/m, "- nukadoko: <version>")
    .replace(/nukadoko\.program\.(ts|rb)/g, "nukadoko.program.*")
    .trimEnd();
}

export default defineStep({
  description: "The summary.md nuka wrote beside run.json is exactly the docstring, with ids, times, the duration, and the version written as <id>, <time>, <duration>, and <version>",
  pattern: "the summary is",
  args: z.object({
    expected: z.string().describe("The whole summary, without its last newline"),
    dir: theProject.returns.shape.dir,
    runDir: nukaRuns.returns.shape.runDir,
  }),
  from: { dir: [[theProject, "dir"], [theProjectInGit, "dir"]], runDir: [nukaRuns, "runDir"] },
  observe({}, { dir, runDir }) {
    return { text: steady(readFileSync(path.join(dir, runDir, "summary.md"), "utf8")) };
  },
  claims: [{ actual: "text", compare: "equal", expected: "expected" }],
});
