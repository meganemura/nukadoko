import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the coupon field is focused",
  description: "Move the focus to the coupon field",
  args: z.object({}),
  returns: z.object({ focused: z.boolean().describe("Whether the focus moved") }),
  mutates: false,
  async run({ page }) {
    await page.focus("#coupon");
    return { focused: true };
  },
});
