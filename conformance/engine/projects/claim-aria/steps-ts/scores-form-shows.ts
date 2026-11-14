import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the scores form shows",
  description: "The scores form's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the form shows") }),
  observe: ({ page }) => ({ form: page.getByRole("form", { name: "Scores" }) }),
  poll: { timeout_ms: 2000 },
  claims: [{ actual: "form", compare: "fits-aria-snapshot", expected: "tree" }],
});
