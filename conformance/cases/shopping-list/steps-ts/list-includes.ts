import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the list on the page includes {name:string}",
  args: z.object({ name: z.string() }),
  async observe({ page }) {
    return { items: await page.locator("#items li").allTextContents() };
  },
  poll: false,
  claims: [{ actual: "items", compare: "has-item", expected: "name" }],
});
