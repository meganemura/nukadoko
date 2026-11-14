import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the page shows",
  description: "The page's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the page shows") }),
  observe: ({ page }) => ({ page }),
  poll: false,
  claims: [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }],
});
