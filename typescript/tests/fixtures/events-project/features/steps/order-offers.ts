import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the page of order {id:int} for {who:string} offers {offer:string}",
  description: "read an order's page as one person, and compare what it offers",
  args: z.object({ id: z.number().int(), who: z.string(), offer: z.string() }),
  async observe({ baseURL }, { id, who }) {
    const response = await fetch(new URL(`/orders/${id}?as=${encodeURIComponent(who)}`, baseURL));
    return { page: await response.text() };
  },
  claims: [{ actual: "page", compare: "equal", expected: "offer" }],
});
