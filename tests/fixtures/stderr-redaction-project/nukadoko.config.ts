import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// The version probe that leaks a loaded value is in nukadoko.program.ts.
export default defineConfig({
  envFiles: [".env.secret"],
  fixtures: defineFixtures({
    // Process scope: `nuka run` announces this teardown on stderr only. A
    // scenario-scope failure is copied onto the scenario record, which is
    // already redacted before that stderr line is printed.
    leakyTeardown: [
      async ({ env }: { env: Readonly<Record<string, string | undefined>> }, use) => {
        await use({ id: "t1" });
        throw new Error(`cleanup of tenant t1 failed: 401 for Bearer ${env.API_TOKEN}`);
      },
      { scope: "process" },
    ],
  }),
});
