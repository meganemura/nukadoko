// Same call shape as a real typed step, but `defineStep` is imported from
// somewhere other than "nukadoko" -- a same-named function from another
// module must never be misread as a step declaration, so this call must
// extract nothing.
import { defineStep } from "not-nukadoko";

export default defineStep({
  pattern: "should never be extracted",
  description: "not the real defineStep",
});
