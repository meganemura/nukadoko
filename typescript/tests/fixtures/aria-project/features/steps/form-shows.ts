import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The same claim on one part of the page: observe returns a locator, and
// the readings repeat until two in a row hold.
export default defineStep({
  pattern: "the scores form shows",
  description: "Judge the scores form's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the page shows") }),
  observe: ({ page }) => ({ form: page.getByRole("form", { name: "Scores" }) }),
  poll: { timeout_ms: 5000 },
  claims: [{ actual: "form", compare: "fits-aria-snapshot", expected: "tree" }],
});
