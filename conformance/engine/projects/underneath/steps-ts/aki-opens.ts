import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Aki opens a page of the shop in a browser context of aki's own",
  pattern: "aki opens the shop page at {path:string}",
  args: z.object({ path: z.string().describe("The page's path") }),
  mutates: false,
  async run({ pageAs }, { path }) {
    const page = await pageAs("aki");
    await page.goto(path);
    await page.waitForFunction("document.title === 'done'");
  },
});
