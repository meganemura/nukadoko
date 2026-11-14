import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the reorder switch is turned on for {who:string}",
  description: "turn the flag quick_reorder on for one person",
  args: z.object({ who: z.string() }),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ baseURL }, { who }) {
    const response = await fetch(new URL(`/switches?as=${encodeURIComponent(who)}`, baseURL), { method: "POST" });
    await response.text();
    return { status: response.status };
  },
});
