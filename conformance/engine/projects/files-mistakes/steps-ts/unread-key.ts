import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "a key nothing reads",
  args: z.object({ path: z.string().describe("A path") }),
  files: { written: { of: writeNotes }, other: { of: writeNotes } },
  claims: [{ actual: "written", compare: "has-item", expected: "path" }],
});
