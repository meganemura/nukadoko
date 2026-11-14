import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Waits until the slow request's last line was written, then sends a
// request of its own.
export default defineStep({
  pattern: "the step calls the fast path",
  description: "wait 600 ms, then GET /fast",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL }) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await (await fetch(new URL("/fast", baseURL))).text();
    return {};
  },
});
