import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A part declared `mutates: true` (the default, spelled out here for
// clarity) — under a read-only environment, `ctx.call` must refuse this
// before its own `run` ever starts, regardless of what the calling step
// itself declared (docs/spec.md "Parts"/"Keyword semantics"). If this ever
// actually runs, it POSTs to the test server — tests/parts.test.ts's own
// request counter is what proves it never did.
export default defineStep({
  description: "A part that would actually write, if it ever ran",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run({ request }) {
    await request.post("/ok");
    return { ok: true };
  },
});
