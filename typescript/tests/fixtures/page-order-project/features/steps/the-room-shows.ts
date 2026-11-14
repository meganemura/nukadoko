import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the room shows {state:string}",
  args: z.object({ state: z.string() }),
  poll: false,
  observe: async ({ page }) => ({ text: await page.locator("#state").textContent() }),
  claims: [{ actual: "text", compare: "equal", expected: "state" }],
});
