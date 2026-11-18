import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "a path inside the list",
  args: z.object({}),
  files: { written: { of: writeNotes } },
  claims: [{ actual: "written.0", compare: "equal", expected: { literal: "notes/" } }],
});
