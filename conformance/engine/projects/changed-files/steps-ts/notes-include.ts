import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "the notes include {path:string}",
  description: "The notes the program added include one path",
  args: z.object({ path: z.string().describe("A path under notes/") }),
  files: { written: { of: writeNotes, change: "added", under: "notes" } },
  claims: [{ actual: "written", compare: "has-item", expected: "path" }],
});
