import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the stamp is made",
  description: "Returns the time the stamp was made",
  args: z.object({}),
  returns: z.object({ createdAt: z.date() }),
  mutates: false,
  async run() {
    return { createdAt: new Date("2026-01-02T03:04:05.000Z") };
  },
});
