import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the cart page is open",
  description: "Show the cart page in the browser",
  args: z.object({}),
  returns: z.object({ heading: z.string().describe("The page's heading") }),
  mutates: false,
  async run({ page }) {
    await page.setContent("<title>Cart</title><h1>Cart</h1><label>Coupon <input id=coupon></label>");
    return { heading: await page.locator("h1").innerText() };
  },
});
