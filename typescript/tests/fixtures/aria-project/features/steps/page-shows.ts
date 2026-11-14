import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The docstring states part of what the page shows, as an ARIA snapshot.
// observe returns the page itself, and nukadoko takes its snapshot.
export default defineStep({
  pattern: "the page shows",
  description: "Judge the page's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the page shows") }),
  observe: ({ page }) => ({ page }),
  poll: false,
  claims: [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }],
});
