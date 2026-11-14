import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Read-only step used to observe the effective baseURL / env for a
// resolved environment: no real HTTP call, no browser, just reading what
// create-context.ts already assembled.
export default defineStep({
  description: "Return the effective baseURL and env values this run resolved to",
  args: z.object({}),
  returns: z.object({
    baseURL: z.string().nullable(),
    key: z.string().nullable(),
    shared: z.string().nullable(),
  }),
  mutates: false,
  async run({ env, baseURL }) {
    return {
      baseURL: baseURL ?? null,
      key: env.KEY ?? null,
      shared: env.SHARED ?? null,
    };
  },
});
