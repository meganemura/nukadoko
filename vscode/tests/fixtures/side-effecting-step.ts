import { writeFileSync } from "node:fs";
import path from "node:path";
import { defineStep } from "nukadoko";
import { z } from "zod";

// Proves the zero-execution property tests/extraction/zero-execution.test.ts
// asserts: this write must never happen, because extractStepDeclarations
// must never import or evaluate this file -- only parse text a caller
// already read with fs.readFile. discover-steps.ts's own real vocabulary
// discovery *does* import files like this one (that's how it lists typed
// steps at all); this extractor exists specifically so an editor never has
// to.
writeFileSync(path.join(__dirname, "zero-execution-marker.txt"), "this file ran");

export default defineStep({
  pattern: "a todo titled {title:string} is added",
  description: "would only prove this ran if tree-sitter ever executed it",
  args: z.object({ title: z.string() }),
  returns: z.object({ title: z.string() }),
  mutates: false,
  run(_fixtures, args) {
    return args;
  },
});
