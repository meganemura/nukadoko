import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the step opens the program's page",
  description: "open /page, which fetches /from-page",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page }) {
    await page.goto("/page");
    await page.waitForFunction('document.title === "done"');
    return {};
  },
});
