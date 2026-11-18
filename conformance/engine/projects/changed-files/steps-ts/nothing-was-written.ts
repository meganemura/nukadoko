import { defineStep, z } from "nukadoko";
import writeMoreNotes from "./write-more-notes.ts";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "nothing was written",
  description: "The program changed no file",
  args: z.object({}),
  files: { changed: { of: [writeNotes, writeMoreNotes] } },
  claims: [{ actual: "changed", compare: "equal", expected: { literal: [] } }],
});
