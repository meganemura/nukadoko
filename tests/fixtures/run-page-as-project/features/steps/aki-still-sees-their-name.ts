import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "aki still sees their own name",
  description: "Reload aki's page and read the name the cookie gives",
  args: z.object({}),
  returns: z.object({ who: z.string() }),
  mutates: false,
  async run({ pageAs }) {
    const aki = await pageAs("aki");
    await aki.goto("/whoami");
    return { who: await aki.locator("#who").innerText() };
  },
});
