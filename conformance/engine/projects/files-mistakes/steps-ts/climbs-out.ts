import { defineStep, z } from "nukadoko";
import writeNotes from "./write-notes.ts";

export default defineStep({
  pattern: "a list climbs out",
  args: z.object({}),
  files: { written: { of: writeNotes, under: "../x" } },
  claims: [{ actual: "written", compare: "equal", expected: { literal: [] } }],
});
