import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The page's heading",
  pattern: "the heading says {text:string}",
  args: z.object({ text: z.string().describe("The heading") }),
  async observe({ page }) {
    return { heading: await page.locator("h1").innerText() };
  },
  claims: [{ actual: "heading", compare: "equal", expected: "text" }],
});
