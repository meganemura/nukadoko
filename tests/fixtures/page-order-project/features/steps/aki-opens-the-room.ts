import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "aki opens the room",
  description: "open /room and wait until it draws its state",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page }) {
    await page.goto("/room");
    await page.waitForFunction('document.getElementById("state").textContent === "ready"');
    return {};
  },
});
