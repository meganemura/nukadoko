import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "a change that is no change",
  args: z.object({}),
  files: { written: { of: writeNotes, change: "moved" as "added" } },
  claims: [{ actual: "written", compare: "equal", expected: { literal: [] } }],
});
