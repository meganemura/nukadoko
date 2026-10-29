import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The page asks the server for /tick every 50 ms, as a live page polls,
// so a walk paused after this step has page traffic while nobody steps.
export default defineStep({
  pattern: "the polling page is open",
  description: "Open the page that polls the server",
  args: z.object({}),
  returns: z.object({ title: z.string().describe("The page's title") }),
  mutates: false,
  async run({ page }) {
    await page.goto("/poll");
    return { title: await page.title() };
  },
});
