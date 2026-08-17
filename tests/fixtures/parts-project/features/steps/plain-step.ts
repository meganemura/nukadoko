import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Calls no part at all — its own step record must have no `calls` key
// (docs/spec.md "Records": absence is the normal case, the same convention
// `used`/`sections` already follow).
export default defineStep({
  description: "A step that never calls a part",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run() {
    return { ok: true };
  },
});
