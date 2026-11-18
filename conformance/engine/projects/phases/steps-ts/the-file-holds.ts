import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";

export default defineStep({
  description: "A file the program's build or prepare wrote holds a line",
  pattern: "the file {name:string} holds {text:string}",
  args: z.object({
    name: z.string().describe("The file, relative to the project"),
    text: z.string().describe("The file's one line"),
  }),
  observe({}, { name }) {
    return { content: readFileSync(name, "utf8").trim() };
  },
  claims: [{ actual: "content", compare: "equal", expected: "text" }],
});
