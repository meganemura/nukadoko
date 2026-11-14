import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

// What differs between two runs of the same project: ids, times, how long
// the run took, the version that wrote it, the browser's version, and how
// late a capture of a page was taken, which depends on the machine.
function steady(text: string): string {
  return text
    .replace(/\b(run|step)-\d{8}-\d{6}-[a-z0-9]{4}\b/g, "$1-<id>")
    .replace(/- started \S+, finished \S+ \([^)]*\)/g, "- started <time>, finished <time> (<duration>)")
    .replace(/^- nukadoko: .*$/m, "- nukadoko: <version>")
    .replace(/^- browser: chromium \S+$/m, "- browser: chromium <version>")
    .replace(/ \(taken \d+ ms after the reading\)/g, "")
    .replace(/`[0-9a-f]{7}`/g, "`<commit>`")
    .replace(/nukadoko\.program\.(ts|rb)/g, "nukadoko.program.*")
    .trimEnd();
}

export default defineStep({
  description: "The summary.md nuka wrote beside run.json is exactly the docstring, with ids, times, the duration, the version, the browser's version, and a short commit hash written as <id>, <time>, <duration>, <version>, chromium <version>, and <commit>, and with no note of how late a page was captured",
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
