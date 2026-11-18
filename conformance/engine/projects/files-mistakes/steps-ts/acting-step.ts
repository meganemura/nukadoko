import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "an acting step reads files",
  args: z.object({}),
  files: { written: { of: writeNotes } },
  mutates: false,
  run() {},
});
