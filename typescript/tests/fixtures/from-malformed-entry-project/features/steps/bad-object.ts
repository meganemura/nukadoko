import { z } from "zod";
import openCart from "./open-cart.js";
import { defineStep } from "../../nukadoko-shim.js";

// `from`'s own compile-time checks (src/step/define-step.ts's `FromMap`)
// reject a bare `Step` at this key. Casting through the well-formed type a
// real candidate here would have (`[typeof openCart, "id"]`, the same
// escape hatch bad-string.ts's own header explains) is the one way a step
// author still gets this wrong at runtime: the value stays `openCart`
// itself, never wrapped in a tuple at all.
export default defineStep({
  description: "from names an upstream with the Step object itself, not a tuple",
  args: z.object({ id: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  from: { id: openCart as unknown as [typeof openCart, "id"] },
  async run() {
    return { ok: true };
  },
});
