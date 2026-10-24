import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// "aki" is a fixed word of the pattern, so the sentence states the value
// the claim compares with. The page is read once after the reload, since
// goto waits for the load.
export default defineStep({
  pattern: "aki still sees their own name",
  description: "Reload aki's page and read the name the cookie gives",
  args: z.object({}),
  async observe({ pageAs }) {
    const aki = await pageAs("aki");
    await aki.goto("/whoami");
    return { who: await aki.locator("#who").innerText() };
  },
  poll: false,
  claims: [{ actual: "who", compare: "equal", expected: { literal: "aki" } }],
});
