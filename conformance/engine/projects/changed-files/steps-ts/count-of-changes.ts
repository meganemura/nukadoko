import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "{count:int} files were written",
  description: "How many paths the program added or changed",
  args: z.object({ count: z.number().int().describe("How many") }),
  files: { written: { of: writeNotes, change: ["added", "changed"] } },
  claims: [{ actual: "written", count: true, compare: "equal", expected: "count" }],
});
