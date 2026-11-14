import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the page is opened and its button pressed",
  description: "Opens the test server's page and presses its one button",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    await page.goto(`${process.env.CHANNELS_BASE}/page`);
    await page.click("button");
    await page.waitForSelector("text=done");
    return { ok: true };
  },
});
