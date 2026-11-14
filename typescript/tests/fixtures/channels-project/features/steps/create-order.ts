import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "an order is created",
  description: "Returns the id of a new order",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  run() {
    return { id: "order-1" };
  },
});
