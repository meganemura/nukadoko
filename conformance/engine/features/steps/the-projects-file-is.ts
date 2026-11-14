import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import theProject from "./the-project.ts";

export default defineStep({
  description: "A file of the project, after the commands ran, holds exactly the docstring",
  pattern: "the project's file {file:string} is",
  args: z.object({
    file: z.string().describe("The file, relative to the project"),
    expected: z.string().describe("The file's whole text, without its last newline"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [theProject, "dir"] },
  observe({}, { file, dir }) {
    return { text: readFileSync(path.join(dir, file), "utf8") };
  },
  claims: [{ actual: "text", view: "text", compare: "equal", expected: "expected" }],
});
