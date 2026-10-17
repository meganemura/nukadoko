import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A step that only destructures `pageAs`: `nuka steps --json` must still say
// it may open a browser.
export default defineStep({
  pattern: "a person opens a page of their own",
  description: "Open a browser context named someone",
  args: z.object({}),
  returns: z.object({}),
  async run({ pageAs }) {
    await pageAs("someone");
    return {};
  },
});
