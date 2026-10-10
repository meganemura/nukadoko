import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Open the app in a browser",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run({ page }) {
    await page.goto("/");
    return { ok: true };
  },
});
