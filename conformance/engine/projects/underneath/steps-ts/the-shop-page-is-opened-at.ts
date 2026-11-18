import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Open a page of the shop and wait until its scripts are done",
  pattern: "the shop page is opened at {path:string}",
  args: z.object({ path: z.string().describe("The page's path") }),
  mutates: false,
  async run({ page }, { path }) {
    await page.goto(path);
    await page.waitForFunction("document.title === 'done'");
  },
});
