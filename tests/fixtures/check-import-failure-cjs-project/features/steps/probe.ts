import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.mjs";

// Deliberately .ts, and otherwise a perfectly ordinary step: this
// fixture's own package.json has no "type": "module", so Node treats a
// .ts file under it as CommonJS, and tsx's own loader fails to resolve
// this very file before a single line of it runs. Nothing about the step
// body below is the cause; renaming this file to probe.mts is the fix, and
// that is exactly the fact the appended sentence in `nuka check`'s
// step-file-import-failed message states.
export default defineStep({
  pattern: "a step probed from a .ts file",
  description: "never reached; this file fails to import before run() exists",
  args: z.object({}),
  returns: z.object({}),
  run() {
    return {};
  },
});
