import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the title shows",
  description: "The page's title against a tree, which it is not",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the page shows") }),
  observe: async ({ page }) => ({ title: await page.title() }),
  poll: false,
  claims: [{ actual: "title", compare: "fits-aria-snapshot", expected: "tree" }],
});
