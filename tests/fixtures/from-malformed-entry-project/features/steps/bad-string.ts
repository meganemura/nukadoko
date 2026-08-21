import { z } from "zod";
import openCart from "./open-cart.js";
import { defineStep } from "../../nukadoko-shim.js";

// `from`'s own compile-time checks (src/step/define-step.ts's `FromMap`)
// reject a bare string at this key. Casting through the well-formed type a
// real candidate here would have (`[typeof openCart, "id"]`) is the one way
// a step author still gets this wrong at runtime: the cast changes only the
// static type the type checker sees, not the actual value, which stays the
// bare string it always was.
export default defineStep({
  description: "from names an upstream with a bare string instead of a [step, key] tuple",
  args: z.object({ id: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  from: { id: "open-cart.id" as unknown as [typeof openCart, "id"] },
  async run() {
    return { ok: true };
  },
});
