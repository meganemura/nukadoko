import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Reads the focus from the page, so it fails if anything between two
// steps, a pause's views among them, moved it.
export default defineStep({
  pattern: "the field {id:string} has the focus",
  description: "Read which field has the focus",
  args: z.object({ id: z.string().describe("The id of the field that should have the focus") }),
  async observe({ page }) {
    return { focused: String(await page.evaluate("document.activeElement?.id ?? ''")) };
  },
  poll: false,
  claims: [{ actual: "focused", compare: "equal", expected: "id" }],
});
