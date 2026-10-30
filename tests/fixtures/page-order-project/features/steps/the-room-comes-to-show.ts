import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the room comes to show {state:string}",
  args: z.object({ state: z.string() }),
  poll: { timeout_ms: 5000 },
  observe: async ({ page }) => ({ text: await page.locator("#state").textContent() }),
  claims: [{ actual: "text", compare: "equal", expected: "state" }],
});
