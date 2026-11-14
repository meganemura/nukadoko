import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

export default defineConfig({
  fixtures: defineFixtures({
    brokenProcessTeardown: [
      async ({}: any, use: any) => {
        await use({ id: "p1" });
        throw new Error("brokenProcessTeardown's own teardown exploded on purpose");
      },
      { scope: "process" },
    ],
  }),
});
