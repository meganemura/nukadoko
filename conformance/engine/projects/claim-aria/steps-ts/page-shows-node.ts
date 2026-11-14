import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the page shows the node {tree:string}",
  description: "The page's accessibility tree against one node the line states",
  args: z.object({ tree: z.string().describe("One line of the ARIA snapshot the page shows") }),
  observe: ({ page }) => ({ page }),
  poll: false,
  claims: [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }],
});
