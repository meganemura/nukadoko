import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "customer {who:string} reorders order {id:int}",
  description: "POST a reorder as one person, which the program refuses where quick_reorder is off",
  args: z.object({ who: z.string(), id: z.number().int() }),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ baseURL }, { who, id }) {
    const response = await fetch(new URL(`/reorders?as=${encodeURIComponent(who)}&order=${id}`, baseURL), { method: "POST" });
    await response.text();
    if (response.status !== 201) throw new Error(`the reorder answered ${response.status}`);
    return { status: response.status };
  },
});
