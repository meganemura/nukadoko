import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Read-only step used to observe the effective ctx.baseURL / ctx.env for a
// resolved environment (this task's spec's environment-resolution tests):
// no real HTTP call, no browser, just reading what create-context.ts already
// assembled.
export default defineStep({
  description: "Return the effective baseURL and env values this run resolved to",
  args: z.object({}),
  returns: z.object({
    baseURL: z.string().nullable(),
    key: z.string().nullable(),
    shared: z.string().nullable(),
  }),
  mutates: false,
  async run(ctx) {
    return {
      baseURL: ctx.baseURL ?? null,
      key: ctx.env.KEY ?? null,
      shared: ctx.env.SHARED ?? null,
    };
  },
});
