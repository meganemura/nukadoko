import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "customer {who:string} opens order {id:int}",
  description: "GET an order's page as one person",
  args: z.object({ who: z.string(), id: z.number().int() }),
  returns: z.object({ status: z.number(), page: z.string() }),
  mutates: false,
  async run({ baseURL }, { who, id }) {
    const response = await fetch(new URL(`/orders/${id}?as=${encodeURIComponent(who)}`, baseURL));
    return { status: response.status, page: await response.text() };
  },
});
