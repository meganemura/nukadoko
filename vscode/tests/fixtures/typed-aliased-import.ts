// `defineStep` is imported under an alias -- import aliasing is out of
// scope for this version (src/extraction/step-extraction.ts's own header),
// so the call below, which uses the local name `ds`, is never recognized:
// the extractor only ever looks for calls literally named `defineStep`.
import { defineStep as ds } from "nukadoko";
import { z } from "zod";

export default ds({
  pattern: "should never be extracted",
  description: "aliased import, out of scope for v1",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
