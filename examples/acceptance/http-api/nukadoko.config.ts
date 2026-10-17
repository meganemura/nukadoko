import { defineConfig, defineFixtures } from "nukadoko";
import { startServer } from "./src/server.ts";

export default defineConfig({
  fixtures: defineFixtures({
    // One server per scenario: the API keeps its items in memory, so a shared
    // server would let one scenario's items show up in another's list.
    server: async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    server: Awaited<ReturnType<typeof startServer>>;
  }
}
