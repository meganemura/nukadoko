import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pre-migration shape, touching `page` through optional chaining
// (`ctx?.page`) rather than a plain `.` access — one of the two forms the
// extraction scan also recognizes, alongside plain
// member access (`ctx?.page?.()` was measured as a false negative before
// this fix). Never actually runs.
export default defineStep({
  pattern: "a legacy optional chaining step runs",
  description: "Un-destructured first argument, touches page via ctx?.page — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(ctx, args) {
    void args;
    const page = ctx?.page;
    void page;
    return {};
  },
});
