import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The program writes this request's last line after the step ended.
export default defineStep({
  pattern: "the step calls the slow path",
  description: "GET /slow, whose last log line comes 400 ms after the answer",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL }) {
    await (await fetch(new URL("/slow", baseURL))).text();
    return {};
  },
});
