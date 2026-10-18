import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Reads the server through the platform's own fetch, which nukadoko does
// not observe, so the step record's HTTP counts are null rather than 0.
export default defineStep({
  pattern: "a fetch read happens",
  description: "GET /ok through fetch instead of request",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ baseURL }) {
    const response = await fetch(new URL("/ok", baseURL));
    return { ok: response.ok };
  },
});
