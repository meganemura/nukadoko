import { defineStep } from "nukadoko";
import { z } from "zod";

// `defineStep`'s own argument here is a variable, not a static object
// literal -- exercises the extractor's fallback when even "which fields
// does this call pass" can't be answered without running the file.
// discover-steps.ts would import and run this file fine (defineStep itself
// doesn't care where its argument literal lives); this extractor, which
// must never run the file, can't.
const stepConfig = {
  pattern: "a {x:int} widgets",
  description: "argument is a variable, not an object literal",
  args: z.object({ x: z.number() }),
  returns: z.object({ x: z.number() }),
  mutates: false,
  run(_fixtures: unknown, args: { x: number }) {
    return args;
  },
};

export default defineStep(stepConfig);
