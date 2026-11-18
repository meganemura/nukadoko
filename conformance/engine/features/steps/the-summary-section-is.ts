import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

// One `## ` section of a summary: its lines after the heading, up to the
// next `## ` heading, so a case reads the part it is about and not the
// environment line, which names a port.
function section(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

export default defineStep({
  description: "The section of the summary.md nuka wrote beside run.json under the heading is exactly the docstring, with no blank lines around it",
  pattern: "the summary's section {heading:string} is",
  args: z.object({
    heading: z.string().describe("The heading, without its ##"),
    expected: z.string().describe("The section's lines after its heading"),
    dir: theProject.returns.shape.dir,
    runDir: nukaRuns.returns.shape.runDir,
  }),
  from: { dir: [[theProject, "dir"], [theProjectInGit, "dir"]], runDir: [nukaRuns, "runDir"] },
  observe({}, { heading, dir, runDir }) {
    return { text: section(readFileSync(path.join(dir, runDir, "summary.md"), "utf8"), heading) ?? "(no such section)" };
  },
  claims: [{ actual: "text", compare: "equal", expected: "expected" }],
});
