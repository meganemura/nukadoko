import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pre-migration shape, touching `page` through optional chaining
// (`ctx?.page`) rather than a plain `.` access — one of the two forms this
// task's spec explicitly asks the scan to also recognize, alongside plain
// member access (that spec's own "背景": `ctx?.page?.()` was a measured
// false negative before this task). Never actually runs.
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
