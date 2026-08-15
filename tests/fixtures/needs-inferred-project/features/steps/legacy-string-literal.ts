import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pre-migration shape, same as legacy-basic.ts, but the only text
// resembling a member access lives inside a string literal — the one false
// positive measured against real steps. `needs_inferred` must read `[]`
// here, not `["page"]`.
// Never actually runs.
export default defineStep({
  pattern: "a legacy string literal step runs",
  description:
    'Un-destructured first argument; "ctx.page" only ever appears inside a string literal — never actually runs',
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(ctx, args) {
    void ctx;
    void args;
    const note = "see ctx.page for details";
    void note;
    return {};
  },
});
