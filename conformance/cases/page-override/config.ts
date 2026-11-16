import { defineConfig, defineFixtures } from "nukadoko";

export default defineConfig({
  fixtures: defineFixtures({
    page: async ({ page }, use) => {
      await page.addInitScript(() => {
        (window as unknown as { wrapped: string }).wrapped = "by the project";
      });
      await use(page);
    },
  }),
});
