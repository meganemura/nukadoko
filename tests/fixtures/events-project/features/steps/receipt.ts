import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "customer {who:string} asks for a receipt of order {id:int}",
  description: "POST a receipt request, whose job the worker performs later",
  args: z.object({ who: z.string(), id: z.number().int() }),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ baseURL }, { who, id }) {
    const response = await fetch(new URL(`/receipts?as=${encodeURIComponent(who)}&order=${id}`, baseURL), { method: "POST" });
    await response.text();
    return { status: response.status };
  },
});
