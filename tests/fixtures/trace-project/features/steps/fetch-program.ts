import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

/** A traceparent of the step's own, which nukadoko keeps. */
export const OWN_TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";

// Three requests through `fetch`: one to the world, one with a
// traceparent of its own, and one to another origin, which refuses the
// connection.
export default defineStep({
  pattern: "the step fetches the program",
  description: "fetch the program, the program with an own traceparent, and another origin",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL }) {
    await (await fetch(new URL("/fetch", baseURL))).text();
    await (await fetch(new URL("/own", baseURL), { headers: { traceparent: OWN_TRACEPARENT } })).text();
    await fetch("http://127.0.0.1:9/elsewhere").catch(() => undefined);
    return {};
  },
});
