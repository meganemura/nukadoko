import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the shopping list is open",
  args: z.object({}),
  mutates: false,
  async run({ page }) {
    await page.goto("/");
    return {};
  },
});
