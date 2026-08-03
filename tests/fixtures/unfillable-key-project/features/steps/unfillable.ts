import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The case this task adds a check for: a required args key with none of the
// four fill paths — no named capture, no table/docstring, no declared
// `from`, and it isn't optional. This line is certain to fail args
// validation the moment it runs; `nuka check`/`nuka run`'s new static check
// (src/check/unfillable-key.ts) catches it instead of leaving it to a
// browser run to discover as args_invalid.
export default defineStep({
  pattern: "a widget is assembled",
  description: "A required args key nothing on this line can ever fill",
  args: z.object({ serial: z.string() }),
  returns: z.object({ serial: z.string() }),
  async run(_ctx, args) {
    return { serial: args.serial };
  },
});
