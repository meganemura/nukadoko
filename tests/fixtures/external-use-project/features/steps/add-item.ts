import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import openCartStep from "./open-cart.js";

// Declares `from: { cartId: [openCartStep, "id"] }` against this file's own
// `open-cart.ts` — the exact declaration `nuka harvest` needs to render this
// step's `cartId` as a chain instead of a literal, once the step record it
// reads names an upstream this same `from` recognizes (this fixture's own
// task: proving `recordStep`'s `use` leaves that evidence
// behind). Real, executable `run`, same reason open-cart.ts's own header
// gives.

export default defineStep({
  pattern: "an item is added",
  description: "Add an item to the open cart",
  args: z.object({ cartId: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  from: { cartId: [openCartStep, "id"] },
  async run({ request }, { cartId }) {
    const res = await request.post(`/carts/${cartId}/items`);
    if (!res.ok()) {
      throw new Error(`add-item: server rejected cart "${cartId}" (status ${res.status()})`);
    }
    return { ok: true };
  },
});
