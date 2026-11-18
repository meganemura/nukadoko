import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "the list contains {path:string}",
  args: z.object({ path: z.string().describe("A path") }),
  files: { written: { of: writeNotes } },
  claims: [{ actual: "written", compare: "contains", expected: "path" }],
});
