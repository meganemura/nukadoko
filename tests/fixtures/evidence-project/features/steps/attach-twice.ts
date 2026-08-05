import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Same `name` attached twice must keep both files, never overwrite the
// first (P9 task spec, test bullet 2).
export default defineStep({
  pattern: "a step attaches the same name twice",
  description: "Calls evidence.attach twice with the same name, different bodies",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    await evidence.attach("dup.txt", "first");
    await evidence.attach("dup.txt", "second");
    return { ok: true };
  },
});
