import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "{name:string} is added on the page",
  args: z.object({ name: z.string() }),
  mutates: true,
  async run({ page }, args) {
    await page.getByLabel("Name").fill(args.name);
    await page.getByRole("button", { name: "Add" }).click();
    await page.locator("#items li", { hasText: args.name }).waitFor();
    return {};
  },
});
