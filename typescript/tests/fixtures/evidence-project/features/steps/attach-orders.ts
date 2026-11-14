import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `evidence.attach` writes immediately and lands on the step record with `at`
// — also the step `nuka steps --json` reads
// to prove `needs: ["evidence"]`/`needs_browser: false` (test bullet 9),
// since it destructures nothing else.
export default defineStep({
  pattern: "a step attaches orders.json",
  description: "Writes one attachment via evidence.attach",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    await evidence.attach("orders.json", '{"ok":true}');
    return { ok: true };
  },
});
