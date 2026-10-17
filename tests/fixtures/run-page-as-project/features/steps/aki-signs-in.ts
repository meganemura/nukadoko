import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "aki signs in",
  description: "Open aki's own browser context and sign in there",
  args: z.object({}),
  returns: z.object({ who: z.string(), script: z.string() }),
  mutates: true,
  async run({ pageAs }) {
    const aki = await pageAs("aki");
    await aki.goto("/sign-in?name=aki");
    return {
      who: await aki.locator("#who").innerText(),
      script: await aki.locator("#script").innerText(),
    };
  },
});
