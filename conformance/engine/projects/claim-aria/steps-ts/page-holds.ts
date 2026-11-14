import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the page holds",
  args: z.object({ html: z.string().describe("The page's HTML") }),
  returns: z.object({}),
  mutates: false,
  async run({ page }, { html }) {
    await page.setContent(html);
    return {};
  },
});
