import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ben signs in with JavaScript turned off",
  description: "Open ben's own browser context with scripts off and sign in there",
  args: z.object({}),
  returns: z.object({ who: z.string(), script: z.string() }),
  mutates: true,
  async run({ pageAs }) {
    const ben = await pageAs("ben", { javaScriptEnabled: false });
    await ben.goto("/sign-in?name=ben");
    return {
      who: await ben.locator("#who").innerText(),
      script: await ben.locator("#script").innerText(),
    };
  },
});
