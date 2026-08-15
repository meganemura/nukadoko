import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// 105 distinct attachments in one execution — more than the 100-entry cap
// (P9 task spec, test bullet 6): the step record must still cap
// `evidence.attachments` at 100 while reporting the true total (105) on
// `truncated.evidence`, the same convention `truncated.actions` already
// uses. A loop calling `attach` unintentionally is exactly the accident
// this cap exists to catch, never pass silently.
export default defineStep({
  pattern: "a step attaches more than the cap allows",
  description: "Calls evidence.attach 105 times with distinct names",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    for (let i = 0; i < 105; i += 1) {
      await evidence.attach(`file-${String(i).padStart(3, "0")}.txt`, String(i));
    }
    return { ok: true };
  },
});
