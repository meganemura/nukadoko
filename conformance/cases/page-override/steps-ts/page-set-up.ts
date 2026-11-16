import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the page was set up by the project",
  args: z.object({}),
  async observe({ page }) {
    return { wrapped: await page.evaluate(() => (window as unknown as { wrapped?: string }).wrapped ?? "not wrapped") };
  },
  poll: false,
  claims: [{ actual: "wrapped", compare: "equal", expected: { literal: "by the project" } }],
});
