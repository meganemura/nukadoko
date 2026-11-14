import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createOrder from "./create-order.js";

// Each key comes from a different place: a capture, the docstring, an
// earlier step's result, and the schema's own default.
export default defineStep({
  pattern: "order {color:string} ships with the note",
  description: "Ships the created order in a color, with a note",
  args: z.object({ color: z.string(), note: z.string(), orderId: z.string(), priority: z.number().default(1) }),
  returns: z.object({ shipped: z.boolean() }),
  from: { orderId: [createOrder, "id"] },
  mutates: false,
  run() {
    return { shipped: true };
  },
});
