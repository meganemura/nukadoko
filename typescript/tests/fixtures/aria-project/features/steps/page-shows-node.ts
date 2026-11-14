import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The same claim with its tree in a capture: one line of an ARIA snapshot.
export default defineStep({
  pattern: "the page shows the node {tree:string}",
  description: "Judge the page's accessibility tree against one node the line states",
  args: z.object({ tree: z.string().describe("One line of the ARIA snapshot the page shows") }),
  observe: ({ page }) => ({ page }),
  poll: false,
  claims: [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }],
});
